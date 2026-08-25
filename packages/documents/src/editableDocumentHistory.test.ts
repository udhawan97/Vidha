import { describe, expect, it } from 'vitest';

import { createEditableDocument } from './editableDocument';
import {
  EDITABLE_DOCUMENT_HISTORY_SCHEMA,
  EditableDocumentHistoryError,
  MAX_EDITABLE_DOCUMENT_VERSIONS,
  createEditableDocumentHistory,
  planEditableDocumentRestore,
  saveEditableDocumentVersion,
  type EditableDocumentHistoryV1,
} from './editableDocumentHistory';

function document(title: string, markdown = `# ${title}`) {
  return createEditableDocument({
    title,
    recipientLabel: 'Mira Chen',
    markdown,
  });
}

describe('Editable Document session history', () => {
  it('records canonical versions with stable monotonic identities', () => {
    const first = saveEditableDocumentVersion(
      createEditableDocumentHistory(),
      document('First'),
      100,
    );
    const second = saveEditableDocumentVersion(
      first.history,
      document('Second'),
      101,
    );

    expect(second.history).toMatchObject({
      schema: EDITABLE_DOCUMENT_HISTORY_SCHEMA,
      schemaVersion: 1,
      nextVersionNumber: 3,
    });
    expect(second.history.versions.map(({ versionId }) => versionId)).toEqual([
      'version-2',
      'version-1',
    ]);
    expect(second.version.document).toEqual(document('Second'));
  });

  it('does not create a duplicate of the latest canonical version', () => {
    const first = saveEditableDocumentVersion(
      createEditableDocumentHistory(),
      document('Same'),
      100,
    );
    const duplicate = saveEditableDocumentVersion(
      first.history,
      document('Same'),
      101,
    );

    expect(duplicate.created).toBe(false);
    expect(duplicate.version.versionId).toBe('version-1');
    expect(duplicate.history).toEqual(first.history);
  });

  it('keeps only the bounded newest versions without reusing identities', () => {
    let history = createEditableDocumentHistory();
    for (
      let index = 1;
      index <= MAX_EDITABLE_DOCUMENT_VERSIONS + 2;
      index += 1
    ) {
      history = saveEditableDocumentVersion(
        history,
        document(`Version ${index}`),
        index,
      ).history;
    }

    expect(history.versions).toHaveLength(MAX_EDITABLE_DOCUMENT_VERSIONS);
    expect(history.versions[0]?.versionId).toBe('version-8');
    expect(history.versions.at(-1)?.versionId).toBe('version-3');
    expect(history.nextVersionNumber).toBe(9);
  });

  it('plans a document-only restore and preserves the current draft first', () => {
    const first = saveEditableDocumentVersion(
      createEditableDocumentHistory(),
      document('Earlier', '# Earlier\n\nOriginal text.'),
      100,
    );
    const current = createEditableDocument({
      title: 'Current',
      recipientLabel: 'Sam Rivera',
      markdown: '# Current\n\nUnsaved text.',
    });
    const plan = planEditableDocumentRestore(
      first.history,
      current,
      'version-1',
      101,
    );

    expect(plan.changes).toEqual({
      hasChanges: true,
      markdownChanged: true,
      recipientChanged: true,
      titleChanged: true,
    });
    expect(plan.document).toEqual(
      document('Earlier', '# Earlier\n\nOriginal text.'),
    );
    expect(plan.preservedCurrentVersion).toMatchObject({
      versionId: 'version-2',
      document: current,
    });
    expect(plan.history.versions.map(({ versionId }) => versionId)).toEqual([
      'version-2',
      'version-1',
    ]);
  });

  it('does not add a version when the current draft already matches the target', () => {
    const saved = saveEditableDocumentVersion(
      createEditableDocumentHistory(),
      document('Same'),
      100,
    );
    const plan = planEditableDocumentRestore(
      saved.history,
      document('Same'),
      'version-1',
      101,
    );

    expect(plan.changes.hasChanges).toBe(false);
    expect(plan.preservedCurrentVersion).toBeNull();
    expect(plan.history).toEqual(saved.history);
  });

  it('retains the restore target when preserving a draft at the history limit', () => {
    let history = createEditableDocumentHistory();
    for (let index = 1; index <= MAX_EDITABLE_DOCUMENT_VERSIONS; index += 1) {
      history = saveEditableDocumentVersion(
        history,
        document(`Version ${index}`),
        index,
      ).history;
    }

    const plan = planEditableDocumentRestore(
      history,
      document('Unsaved current'),
      'version-1',
      100,
    );

    expect(plan.history.versions).toHaveLength(MAX_EDITABLE_DOCUMENT_VERSIONS);
    expect(plan.history.versions.map(({ versionId }) => versionId)).toEqual([
      'version-7',
      'version-6',
      'version-5',
      'version-4',
      'version-3',
      'version-1',
    ]);
    expect(plan.targetVersion.versionId).toBe('version-1');
    expect(plan.preservedCurrentVersion?.versionId).toBe('version-7');
  });

  it('keeps identity ordering stable when the system clock moves backward', () => {
    const first = saveEditableDocumentVersion(
      createEditableDocumentHistory(),
      document('First'),
      100,
    );
    const second = saveEditableDocumentVersion(
      first.history,
      document('Second'),
      99,
    );

    expect(second.version.versionId).toBe('version-2');
    expect(second.history.versions.map(({ savedAt }) => savedAt)).toEqual([
      99, 100,
    ]);
  });

  it('fails closed for missing versions and invalid time', () => {
    const saved = saveEditableDocumentVersion(
      createEditableDocumentHistory(),
      document('First'),
      100,
    );

    expect(() =>
      saveEditableDocumentVersion(saved.history, document('Second'), -1),
    ).toThrow(EditableDocumentHistoryError);
    expect(() =>
      saveEditableDocumentVersion(
        saved.history,
        document('Second'),
        8_640_000_000_000_001,
      ),
    ).toThrow(EditableDocumentHistoryError);
    expect(() =>
      planEditableDocumentRestore(
        saved.history,
        document('Current'),
        'version-99',
        101,
      ),
    ).toThrow(EditableDocumentHistoryError);
  });

  it('rejects unsupported, sparse, duplicate, reordered, and gapped history', () => {
    const saved = saveEditableDocumentVersion(
      createEditableDocumentHistory(),
      document('First'),
      100,
    );
    const unsupported = {
      ...saved.history,
      schemaVersion: 2,
    } as unknown as EditableDocumentHistoryV1;
    const sparseVersions = new Array(
      1,
    ) as EditableDocumentHistoryV1['versions'];
    const sparse = {
      ...saved.history,
      versions: sparseVersions,
    };
    const duplicate = {
      ...saved.history,
      versions: [saved.history.versions[0]!, saved.history.versions[0]!],
    };
    const gapped = {
      ...saved.history,
      nextVersionNumber: 3,
    };

    for (const malformed of [
      { ...saved.history, hidden: true } as EditableDocumentHistoryV1,
      unsupported,
      sparse,
      duplicate,
      gapped,
      { ...createEditableDocumentHistory(), nextVersionNumber: 100 },
    ]) {
      expect(() =>
        saveEditableDocumentVersion(malformed, document('Second'), 101),
      ).toThrow(EditableDocumentHistoryError);
    }
    expect(() =>
      saveEditableDocumentVersion(
        {
          ...saved.history,
          nextVersionNumber: 3,
          versions: [
            saved.history.versions[0]!,
            {
              ...saved.history.versions[0]!,
              versionId: 'version-2',
              versionNumber: 2,
            },
          ],
        },
        document('Second'),
        101,
      ),
    ).toThrow(EditableDocumentHistoryError);
  });

  it('fails closed when the safe identity counter is exhausted', () => {
    const lastVersionNumber = Number.MAX_SAFE_INTEGER - 2;
    const exhausted: EditableDocumentHistoryV1 = {
      schema: EDITABLE_DOCUMENT_HISTORY_SCHEMA,
      schemaVersion: 1,
      nextVersionNumber: Number.MAX_SAFE_INTEGER - 1,
      versions: [
        {
          versionId: `version-${lastVersionNumber}`,
          versionNumber: lastVersionNumber,
          savedAt: 100,
          document: document('Last safe version'),
        },
      ],
    };

    expect(() =>
      saveEditableDocumentVersion(exhausted, document('Too far'), 101),
    ).toThrow(/exhausted its safe version identities/i);
  });

  it('snapshots accessor-backed document fields exactly once', () => {
    let titleReads = 0;
    const mutable = {
      schema: 'vidha.editable-document',
      schemaVersion: 1,
      get title() {
        titleReads += 1;
        return titleReads === 1 ? 'Stable title' : '';
      },
      recipientLabel: 'Mira Chen',
      markdown: '# Stable',
    } as EditableDocumentHistoryV1['versions'][number]['document'];

    const saved = saveEditableDocumentVersion(
      createEditableDocumentHistory(),
      mutable,
      100,
    );

    expect(saved.version.document.title).toBe('Stable title');
    expect(titleReads).toBe(1);
  });
});
