import { describe, test } from 'node:test';
import assert from 'node:assert';
import cds from '@sap/cds';
import registerHandlersForRecommendations from '../lib/handlers/recommendations.js';

const STRUCT = 'SAP_Recommendations';
const RECO_TARGET = 'MyService.MyEntity.recommendations';

describe('Recommendations READ handler', () => {
  test('a draft READ without SELECT.columns does not fail on the missing column list', async () => {
    cds.model = {
      definitions: {
        [RECO_TARGET]: { elements: { technicalRecommendationsIdentifier: {}, field1: {} } }
      }
    };
    cds.context = { model: cds.model };

    let readHandler;
    registerHandlersForRecommendations({
      prepend: (fn) => fn(),
      on: (_event, fn) => {
        readHandler = fn;
      },
      run: async () => []
    });

    const req = {
      target: {
        isDraft: true,
        name: 'MyService.MyEntity',
        '@UI.Recommendations': { '=': STRUCT },
        actives: {
          '@UI.Recommendations': { '=': STRUCT },
          elements: { ID: { type: 'cds.UUID' }, [STRUCT]: { target: RECO_TARGET } }
        },
        elements: { ID: { type: 'cds.UUID' }, field1: {} },
        keys: { ID: {} }
      },
      query: {
        elements: { [STRUCT]: {} },
        SELECT: { from: { ref: ['MyEntity'] } }
      },
      _: { event: 'READ' }
    };

    // The mocked target cannot run real queries, so the handler may still reject further down.
    // What matters here is that it no longer throws on the undefined `SELECT.columns`.
    await readHandler(req, async () => []).catch((err) => {
      assert.doesNotMatch(String(err?.message), /findIndex|reading 'columns'/);
    });
    assert.deepStrictEqual(req.query.SELECT.columns, ['*']);
  });
});
