import path from 'path';
import { describe, test, before } from 'node:test';
import assert from 'node:assert';
import cdsTest from '@cap-js/cds-test';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let { GET, POST, PATCH } = cdsTest(path.join(__dirname, './bookshop'));

describe('Local RPT recommendations (AICore-local e2e)', () => {
  before(async () => {
    // Wait for the Python subprocess to boot and the model to be ready.
    // LocalSubprocessRPTService exposes _ready on the AICore service instance.
    const aiCore = await (await import('@sap/cds')).default.connect.to('AICore');
    if (aiCore._ready) await aiCore._ready;
  });

  test('recommendations are returned in draft mode', async () => {
    const { data: { ID } } = await POST('/odata/v4/catalog/Books', {
      ID: Math.round(Math.random() * 10000)
    });
    const { status, data } = await GET(
      `/odata/v4/catalog/Books(ID=${ID},IsActiveEntity=false)?$expand=SAP_Recommendations`
    );
    assert.strictEqual(status, 200);
    assert.ok(data.SAP_Recommendations);
    assert.ok(data.SAP_Recommendations.author_ID.length);
  });

  test('recommendations contain a default suggestion', async () => {
    const { data: { ID } } = await POST('/odata/v4/catalog/Books', {
      ID: Math.round(Math.random() * 10000)
    });
    const { status, data } = await GET(
      `/odata/v4/catalog/Books(ID=${ID},IsActiveEntity=false)?$expand=SAP_Recommendations`
    );
    assert.strictEqual(status, 200);
    for (const field of Object.keys(data.SAP_Recommendations)) {
      assert.strictEqual(data.SAP_Recommendations[field][0].RecommendedFieldIsSuggestion, true);
    }
  });

  test('description populated via @Common.Text', async () => {
    const { data: { ID } } = await POST('/odata/v4/catalog/Books', {
      ID: Math.round(Math.random() * 10000)
    });
    const { data } = await GET(
      `/odata/v4/catalog/Books(ID=${ID},IsActiveEntity=false)?$expand=SAP_Recommendations`
    );
    const rec = data.SAP_Recommendations['author_ID'][0];
    assert.ok(rec.RecommendedFieldDescription, 'expected description from @Common.Text');
  });

  test('@UI.RecommendationState: 0 disables field', async () => {
    const { data: { ID } } = await POST('/odata/v4/catalog/Books', {
      ID: Math.round(Math.random() * 10000)
    });
    const { data } = await GET(
      `/odata/v4/catalog/Books(ID=${ID},IsActiveEntity=false)?$expand=SAP_Recommendations`
    );
    assert.strictEqual(!!data.SAP_Recommendations['authorWORecommendations_ID'], false);
  });

  test('dynamic @UI.RecommendationState expression enables/disables field', async () => {
    const { data: { ID } } = await POST('/odata/v4/catalog/Books', {
      ID: Math.round(Math.random() * 10000),
      genre_ID: 13
    });
    const { data: off } = await GET(
      `/odata/v4/catalog/Books(ID=${ID},IsActiveEntity=false)?$expand=SAP_Recommendations`
    );
    assert.strictEqual(!!off.SAP_Recommendations['authorWDynamicRecommendations_ID'], false);

    await PATCH(`/odata/v4/catalog/Books(ID=${ID},IsActiveEntity=false)`, { genre_ID: 10 });
    const { data: on } = await GET(
      `/odata/v4/catalog/Books(ID=${ID},IsActiveEntity=false)?$expand=SAP_Recommendations`
    );
    assert.strictEqual(!!on.SAP_Recommendations['authorWDynamicRecommendations_ID'], true);
  });

  test('entity with non-ID key returns recommendations', async () => {
    const { data: { notID } } = await POST('/odata/v4/catalog/BooksWithCustomKey', {
      notID: Math.round(Math.random() * 10000)
    });
    const { status, data } = await GET(
      `/odata/v4/catalog/BooksWithCustomKey(notID=${notID},IsActiveEntity=false)?$expand=SAP_Recommendations`
    );
    assert.strictEqual(status, 200);
    assert.ok(data.SAP_Recommendations.currency_code.length);
  });

  test('entity with composed keys returns recommendations', async () => {
    const { data: { key1, key2 } } = await POST('/odata/v4/catalog/BooksWithComposedKey', {
      key1: Math.round(Math.random() * 10000),
      key2: Math.round(Math.random() * 10000)
    });
    const { status, data } = await GET(
      `/odata/v4/catalog/BooksWithComposedKey(key1=${key1},key2=${key2},IsActiveEntity=false)?$expand=SAP_Recommendations`
    );
    assert.strictEqual(status, 200);
    assert.ok(data.SAP_Recommendations.currency_code.length);
  });
});
