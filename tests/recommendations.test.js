import path from 'path';
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import cds from '@sap/cds';
import cdsTest from '@cap-js/cds-test';
import { fileURLToPath } from 'url';
// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let { GET, POST, PATCH, axios } = cdsTest(path.join(__dirname, './bookshop'));
axios.defaults.auth = { username: 'alice' };

describe('Classification predictions', () => {
  test('requesting recommendations on active entity return nothing', async () => {
    const { status, data } = await GET('/odata/v4/catalog/Books?$expand=SAP_Recommendations');
    assert.strictEqual(status, 200);
    assert.ok(data.value.length >= 0);
  });

  test('active entity returns SAP_Recommendations as null', async () => {
    const { status, data } = await GET(
      '/odata/v4/catalog/Books(ID=201,IsActiveEntity=true)?$expand=SAP_Recommendations'
    );
    assert.strictEqual(status, 200);
    assert.strictEqual('SAP_Recommendations' in data, true);
    assert.strictEqual(data.SAP_Recommendations, null);
  });

  test('In draft mode recommendations are returned', async () => {
    const {
      data: { ID }
    } = await POST(`/odata/v4/catalog/Books`, { ID: Math.round(Math.random() * 10000) });
    const { status, data } = await GET(
      `/odata/v4/catalog/Books(ID=${ID},IsActiveEntity=false)?$expand=SAP_Recommendations`
    );
    assert.strictEqual(status, 200);
    assert.ok(data);
    assert.ok(data.SAP_Recommendations);
    assert.ok(data.SAP_Recommendations.author_ID.length);
  });

  test('One recommendation is marked with as default', async () => {
    const {
      data: { ID }
    } = await POST(`/odata/v4/catalog/Books`, { ID: Math.round(Math.random() * 10000) });
    const { status, data } = await GET(
      `/odata/v4/catalog/Books(ID=${ID},IsActiveEntity=false)?$expand=SAP_Recommendations`
    );
    assert.strictEqual(status, 200);
    for (const recommendation in data.SAP_Recommendations) {
      assert.strictEqual(
        data.SAP_Recommendations[recommendation][0].RecommendedFieldIsSuggestion,
        true
      );
    }
  });

  test('Description is added when field as Common.Text', async () => {
    const {
      data: { ID }
    } = await POST(`/odata/v4/catalog/Books`, { ID: Math.round(Math.random() * 10000) });
    const { status, data } = await GET(
      `/odata/v4/catalog/Books(ID=${ID},IsActiveEntity=false)?$expand=SAP_Recommendations`
    );
    assert.strictEqual(status, 200);
    const author = await SELECT.one
      .from(`CatalogService.Authors`)
      .where({ ID: data.SAP_Recommendations['author_ID'][0].RecommendedFieldValue });
    assert.strictEqual(
      data.SAP_Recommendations['author_ID'][0].RecommendedFieldDescription,
      author.name
    );
  });

  test('@UI.RecommendationState: 0 disable recommendations for VH field', async () => {
    assert.equal(
      !!cds.model.definitions['CatalogService.Books_Recommendations'].elements[
        'authorWORecommendations_ID'
      ],
      false
    );

    const {
      data: { ID }
    } = await POST(`/odata/v4/catalog/Books`, { ID: Math.round(Math.random() * 10000) });
    const { data } = await GET(
      `/odata/v4/catalog/Books(ID=${ID},IsActiveEntity=false)?$expand=SAP_Recommendations`
    );
    assert.strictEqual(!!data.SAP_Recommendations['authorWORecommendations_ID'], false);
  });

  test('@UI.RecommendationState with expression can disable recommendations', async () => {
    assert.equal(
      !!cds.model.definitions['CatalogService.Books_Recommendations'].elements[
        'authorWDynamicRecommendations_ID'
      ],
      true
    );

    const {
      data: { ID }
    } = await POST(`/odata/v4/catalog/Books`, {
      ID: Math.round(Math.random() * 10000),
      genre_ID: 13
    });
    const { data } = await GET(
      `/odata/v4/catalog/Books(ID=${ID},IsActiveEntity=false)?$expand=SAP_Recommendations`
    );
    assert.strictEqual(!!data.SAP_Recommendations['authorWDynamicRecommendations_ID'], false);

    await PATCH(`/odata/v4/catalog/Books(ID=${ID},IsActiveEntity=false)`, { genre_ID: 10 });
    const { data: dataRound2 } = await GET(
      `/odata/v4/catalog/Books(ID=${ID},IsActiveEntity=false)?$expand=SAP_Recommendations`
    );
    assert.strictEqual(!!dataRound2.SAP_Recommendations['authorWDynamicRecommendations_ID'], true);
  });

  test('Entity without recommendations is skipped', async () => {
    const { status, data } = await GET(`/odata/v4/catalog/Authors`);
    assert.strictEqual(status, 200);
    assert.ok(data.value.length >= 0);
  });

  test('Recommendations work on entity with a non ID column', async () => {
    const {
      data: { notID }
    } = await POST(`/odata/v4/catalog/BooksWithCustomKey`, {
      notID: Math.round(Math.random() * 10000)
    });
    const { data, status } = await GET(
      `/odata/v4/catalog/BooksWithCustomKey(notID=${notID},IsActiveEntity=false)?$expand=SAP_Recommendations`
    );
    assert.strictEqual(status, 200);
    assert.ok(data);
    assert.ok(data.SAP_Recommendations);
    assert.ok(data.SAP_Recommendations.currency_code.length);
  });

  test('Recommendations work on entities with composed keys', async () => {
    const {
      data: { key1, key2 }
    } = await POST(`/odata/v4/catalog/BooksWithComposedKey`, {
      key1: Math.round(Math.random() * 10000),
      key2: Math.round(Math.random() * 10000)
    });
    const { data, status } = await GET(
      `/odata/v4/catalog/BooksWithComposedKey(key1=${key1},key2=${key2},IsActiveEntity=false)?$expand=SAP_Recommendations`
    );
    assert.strictEqual(status, 200);
    assert.ok(data);
    assert.ok(data.SAP_Recommendations);
    assert.ok(data.SAP_Recommendations.currency_code.length);
  });

  test('Recommendations are added to composition targets', async () => {
    // Chapters is a Composition target of Books (which is draft-enabled)
    const {
      data: { ID }
    } = await POST(`/odata/v4/catalog/Books`, { ID: Math.round(Math.random() * 10000) });
    const { data: chapter } = await POST(
      `/odata/v4/catalog/Books(ID=${ID},IsActiveEntity=false)/chapters`,
      { title: 'Test Chapter' }
    );
    const { status, data } = await GET(
      `/odata/v4/catalog/Chapters(ID=${chapter.ID},IsActiveEntity=false)?$expand=SAP_Recommendations`
    );
    assert.strictEqual(status, 200);
    assert.ok(data);
    assert.ok(data.SAP_Recommendations);
    assert.ok(data.SAP_Recommendations.genre_ID.length);
  });
});

describe('Regression predictions', () => {
  test('Scalar field with @UI.RecommendationState is included in Recommendations entity', async () => {
    assert.equal(
      !!cds.model.definitions['CatalogService.Books_Recommendations'].elements['price'],
      true
    );
  });

  test('Predictions are returned for scalar field with @UI.RecommendationState', async () => {
    const {
      data: { ID }
    } = await POST(`/odata/v4/catalog/Books`, { ID: Math.round(Math.random() * 10000) });
    const { status, data } = await GET(
      `/odata/v4/catalog/Books(ID=${ID},IsActiveEntity=false)?$expand=SAP_Recommendations`
    );
    assert.strictEqual(status, 200);
    assert.ok(data.SAP_Recommendations);
    assert.ok(data.SAP_Recommendations.price.length);
    const rec = data.SAP_Recommendations.price[0].RecommendedFieldValue;
    assert.ok(
      typeof rec === 'number' || typeof rec === 'string',
      `RecommendedFieldValue has unexpected type: ${typeof rec}`
    );
    assert.ok(Number.isFinite(Number(rec)), `RecommendedFieldValue is not numeric: ${rec}`);
  });
});
