import * as commands from 'app/client/components/commands';
import {Cursor} from 'app/client/components/Cursor';
import {GristDoc} from 'app/client/components/GristDoc';
import {UnsavedChange} from 'app/client/components/UnsavedChanges';
import {DataRowModel} from 'app/client/models/DataRowModel';
import {ColumnRec} from 'app/client/models/entities/ColumnRec';
import {ViewFieldRec} from 'app/client/models/entities/ViewFieldRec';
import {reportError} from 'app/client/models/errors';
import {showTooltipToCreateFormula} from 'app/client/widgets/EditorTooltip';
import {FormulaEditor} from 'app/client/widgets/FormulaEditor';
import {IEditorCommandGroup, NewBaseEditor} from 'app/client/widgets/NewBaseEditor';
import {asyncOnce} from "app/common/AsyncCreate";
import {CellValue} from "app/common/DocActions";
import {isRaisedException} from 'app/common/gristTypes';
import * as gutil from 'app/common/gutil';
import {Disposable, Holder, IDisposable, MultiHolder, Observable} from 'grainjs';
import isEqual = require('lodash/isEqual');

type IEditorConstructor = typeof NewBaseEditor;

/**
 * Check if the typed-in value should change the cell without opening the cell editor, and if so,
 * saves and returns true. E.g. on typing space, CheckBoxEditor toggles the cell without opening.
 */
export function saveWithoutEditor(
  editorCtor: IEditorConstructor, editRow: DataRowModel, field: ViewFieldRec, typedVal: string|undefined
): boolean {
  // Never skip the editor if editing a formula. Also, check that skipEditor static function
  // exists (we don't bother adding it on old-style JS editors that don't need it).
  if (!field.column.peek().isRealFormula.peek() && editorCtor.skipEditor) {
    const origVal = editRow.cells[field.colId()].peek();
    const skipEditorValue = editorCtor.skipEditor(typedVal, origVal);
    if (skipEditorValue !== undefined) {
      setAndSave(editRow, field, skipEditorValue).catch(reportError);
      return true;
    }
  }
  return false;
}

// Set the given field of editRow to value, only if different from the current value of the cell.
export async function setAndSave(editRow: DataRowModel, field: ViewFieldRec, value: CellValue): Promise<void> {
  const obs = editRow.cells[field.colId()];
  if (!isEqual(value, obs.peek())) {
    return obs.setAndSave(value);
  }
}

export class FieldEditor extends Disposable {
  private _gristDoc: GristDoc;
  private _field: ViewFieldRec;
  private _cursor: Cursor;
  private _editRow: DataRowModel;
  private _cellElem: Element;
  private _editCommands: IEditorCommandGroup;
  private _editorCtor: IEditorConstructor;
  private _editorHolder: Holder<NewBaseEditor> = Holder.create(this);
  private _saveEdit = asyncOnce(() => this._doSaveEdit());

  constructor(options: {
    gristDoc: GristDoc,
    field: ViewFieldRec,
    cursor: Cursor,
    editRow: DataRowModel,
    cellElem: Element,
    editorCtor: IEditorConstructor,
    startVal?: string,
  }) {
    super();
    this._gristDoc = options.gristDoc;
    this._field = options.field;
    this._cursor = options.cursor;
    this._editRow = options.editRow;
    this._editorCtor = options.editorCtor;
    this._cellElem = options.cellElem;

    const startVal = options.startVal;
    let offerToMakeFormula = false;

    const column = this._field.column();
    let isFormula: boolean = column.isRealFormula.peek();
    let editValue: string|undefined = startVal;
    if (startVal && gutil.startsWith(startVal, '=')) {
      if (isFormula || this._field.column().isEmpty()) {
        // If we typed '=' on an empty column, convert it to a formula. If on a formula column,
        // start editing ignoring the initial '='.
        isFormula = true;
        editValue = gutil.removePrefix(startVal, '=') as string;
      } else {
        // If we typed '=' on a non-empty column, only suggest to convert it to a formula.
        offerToMakeFormula = true;
      }
    }

    // These are the commands for while the editor is active.
    this._editCommands = {
      // _saveEdit disables this command group, so when we run fieldEditSave again, it triggers
      // another registered group, if any. E.g. GridView listens to it to move the cursor down.
      fieldEditSave: () => {
        this._saveEdit().then((jumped: boolean) => {
          // To avoid confusing cursor movement, do not increment the rowIndex if the row
          // was re-sorted after editing.
          if (!jumped) { commands.allCommands.fieldEditSave.run(); }
        })
        .catch(reportError);
      },
      fieldEditSaveHere: () => { this._saveEdit().catch(reportError); },
      fieldEditCancel: () => { this.dispose(); },
      prevField: () => { this._saveEdit().then(commands.allCommands.prevField.run).catch(reportError); },
      nextField: () => { this._saveEdit().then(commands.allCommands.nextField.run).catch(reportError); },
      makeFormula: () => this._makeFormula(),
      unmakeFormula: () => this._unmakeFormula(),
    };

    this.rebuildEditor(isFormula, editValue, Number.POSITIVE_INFINITY);

    if (offerToMakeFormula) {
      this._offerToMakeFormula();
    }

    setupEditorCleanup(this, this._gristDoc, this._field, this._saveEdit);
  }

  // cursorPos refers to the position of the caret within the editor.
  public rebuildEditor(isFormula: boolean, editValue: string|undefined, cursorPos: number) {
    const editorCtor: IEditorConstructor = isFormula ? FormulaEditor : this._editorCtor;

    const column = this._field.column();
    const cellCurrentValue = this._editRow.cells[this._field.colId()].peek();
    const cellValue = column.isFormula() ? column.formula() : cellCurrentValue;

    // Enter formula-editing mode (e.g. click-on-column inserts its ID) only if we are opening the
    // editor by typing into it (and overriding previous formula). In other cases (e.g. double-click),
    // we defer this mode until the user types something.
    this._field.editingFormula(isFormula && editValue !== undefined);

    // Replace the item in the Holder with a new one, disposing the previous one.
    const editor = this._editorHolder.autoDispose(editorCtor.create({
      gristDoc: this._gristDoc,
      field: this._field,
      cellValue,
      formulaError: getFormulaError(this._gristDoc, this._editRow, column),
      editValue,
      cursorPos,
      commands: this._editCommands,
    }));
    editor.attach(this._cellElem);
  }

  private _makeFormula() {
    const editor = this._editorHolder.get();
    // On keyPress of "=" on textInput, consider turning the column into a formula.
    if (editor && !this._field.editingFormula.peek() && editor.getCursorPos() === 0) {
      if (this._field.column().isEmpty()) {
        // If we typed '=' an empty column, convert it to a formula.
        this.rebuildEditor(true, editor.getTextValue(), 0);
        return false;
      } else {
        // If we typed '=' on a non-empty column, only suggest to convert it to a formula.
        this._offerToMakeFormula();
      }
    }
    return true;    // don't stop propagation.
  }

  private _unmakeFormula() {
    const editor = this._editorHolder.get();
    // Only convert to data if we are undoing a to-formula conversion. To convert formula to
    // data, use column menu option, or delete the formula first (which makes the column "empty").
    if (editor && this._field.editingFormula.peek() && editor.getCursorPos() === 0 &&
      !this._field.column().isRealFormula()) {
      // Restore a plain '=' character. This gives a way to enter "=" at the start if line. The
      // second backspace will delete it.
      this.rebuildEditor(false, '=' + editor.getTextValue(), 1);
      return false;
    }
    return true;    // don't stop propagation.
  }

  private _offerToMakeFormula() {
    const editorDom = this._editorHolder.get()?.getDom();
    if (!editorDom) { return; }
    showTooltipToCreateFormula(editorDom, () => this._convertEditorToFormula());
  }

  private _convertEditorToFormula() {
    const editor = this._editorHolder.get();
    if (editor) {
      const editValue = editor.getTextValue();
      const formulaValue = editValue.startsWith('=') ? editValue.slice(1) : editValue;
      this.rebuildEditor(true, formulaValue, 0);
    }
  }

  // Returns true if Enter/Shift+Enter should NOT move the cursor, for instance if the current
  // record got reordered (i.e. the cursor jumped), or when editing a formula.
  private async _doSaveEdit(): Promise<boolean> {
    const editor = this._editorHolder.get();
    if (!editor) { return false; }
    // Make sure the editor is save ready
    const saveIndex = this._cursor.rowIndex();
    await editor.prepForSave();
    if (this.isDisposed()) {
      // We shouldn't normally get disposed here, but if we do, avoid confusing JS errors.
      console.warn("Unable to finish saving edited cell");  // tslint:disable-line:no-console
      return false;
    }

    // Then save the value the appropriate way
    // TODO: this isFormula value doesn't actually reflect if editing the formula, since
    // editingFormula() is used for toggling column headers, and this is deferred to start of
    // typing (a double-click or Enter) does not immediately set it. (This can cause a
    // console.warn below, although harmless.)
    const isFormula = this._field.editingFormula();
    const col = this._field.column();
    let waitPromise: Promise<unknown>|null = null;

    if (isFormula) {
      const formula = editor.getCellValue();
      // Bundle multiple changes so that we can undo them in one step.
      if (isFormula !== col.isFormula.peek() || formula !== col.formula.peek()) {
        waitPromise = this._gristDoc.docData.bundleActions(null, () => Promise.all([
          col.updateColValues({isFormula, formula}),
          // If we're saving a non-empty formula, then also add an empty record to the table
          // so that the formula calculation is visible to the user.
          (this._editRow._isAddRow.peek() && formula !== "" ?
            this._editRow.updateColValues({}) : undefined),
        ]));
      }
    } else {
      const value = editor.getCellValue();
      if (col.isRealFormula()) {
        // tslint:disable-next-line:no-console
        console.warn("It should be impossible to save a plain data value into a formula column");
      } else {
        // This could still be an isFormula column if it's empty (isEmpty is true), but we don't
        // need to toggle isFormula in that case, since the data engine takes care of that.
        waitPromise = setAndSave(this._editRow, this._field, value);
      }
    }
    const cursor = this._cursor;
    // Deactivate the editor. We are careful to avoid using `this` afterwards.
    this.dispose();
    await waitPromise;
    return isFormula || (saveIndex !== cursor.rowIndex());
  }
}

/**
 * Open a formula editor in the side pane. Returns a Disposable that owns the editor.
 */
export function openSideFormulaEditor(options: {
  gristDoc: GristDoc,
  field: ViewFieldRec,
  editRow: DataRowModel,      // Needed to get exception value, if any.
  refElem: Element,           // Element in the side pane over which to position the editor.
}): IDisposable {
  const {gristDoc, field, editRow, refElem} = options;
  const holder = MultiHolder.create(null);
  const column = field.column();

  // AsyncOnce ensures it's called once even if triggered multiple times.
  const saveEdit = asyncOnce(async () => {
    const formula = editor.getCellValue();
    if (formula !== column.formula.peek()) {
      await column.updateColValues({formula});
    }
    holder.dispose();     // Deactivate the editor.
  });

  // These are the commands for while the editor is active.
  const editCommands = {
    fieldEditSave: () => { saveEdit().catch(reportError); },
    fieldEditSaveHere: () => { saveEdit().catch(reportError); },
    fieldEditCancel: () => { holder.dispose(); },
  };

  // Replace the item in the Holder with a new one, disposing the previous one.
  const editor = FormulaEditor.create(holder, {
    gristDoc,
    field,
    cellValue: column.formula(),
    formulaError: getFormulaError(gristDoc, editRow, column),
    editValue: undefined,
    cursorPos: Number.POSITIVE_INFINITY,    // Position of the caret within the editor.
    commands: editCommands,
    cssClass: 'formula_editor_sidepane',
  });
  editor.attach(refElem);

  // Enter formula-editing mode (highlight formula icons; click on a column inserts its ID).
  field.editingFormula(true);
  setupEditorCleanup(holder, gristDoc, field, saveEdit);
  return holder;
}


/**
 * For an active editor, set up its cleanup:
 * - saving on click-away (when focus returns to Grist "clipboard" element)
 * - unset field.editingFormula mode
 * - Arrange for UnsavedChange protection against leaving the page with unsaved changes.
 */
function setupEditorCleanup(
  owner: MultiHolder, gristDoc: GristDoc, field: ViewFieldRec, saveEdit: () => Promise<unknown>
) {
  // Whenever focus returns to the Clipboard component, close the editor by saving the value.
  gristDoc.app.on('clipboard_focus', saveEdit);

  // TODO: This should ideally include a callback that returns true only when the editor value
  // has changed. Currently an open editor is considered unsaved even when unchanged.
  UnsavedChange.create(owner, async () => { await saveEdit(); });

  owner.onDispose(() => {
    gristDoc.app.off('clipboard_focus', saveEdit);
    // Unset field.editingFormula flag when the editor closes.
    field.editingFormula(false);
  });
}

/**
 * If the cell at the given row and column is a formula value containing an exception, return an
 * observable with this exception, and fetch more details to add to the observable.
 */
function getFormulaError(
  gristDoc: GristDoc, editRow: DataRowModel, column: ColumnRec
): Observable<CellValue>|undefined {
  const colId = column.colId.peek();
  let formulaError: Observable<CellValue>|undefined;
  const cellCurrentValue = editRow.cells[colId].peek();
  if (column.isFormula() && isRaisedException(cellCurrentValue)) {
    const fv = formulaError = Observable.create(null, cellCurrentValue);
    gristDoc.docData.getFormulaError(column.table().tableId(), colId, editRow.getRowId())
      .then(value => { fv.set(value); })
      .catch(reportError);
  }
  return formulaError;
}
