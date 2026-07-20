import path from 'path';
import { describe, test } from 'node:test';
import assert from 'node:assert';
import cds from '@sap/cds';
import cdsTest from '@cap-js/cds-test';
import { fileURLToPath } from 'url';
// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let { GET, POST, axios } = cdsTest(path.join(__dirname, './bookshop'));
axios.defaults.auth = { username: 'alice' };
// Must be set before the server boots (cds-test starts it in a before hook);
// the csn enhancement reads the flag at compile time.
cds.env.requires.AICore.recommendations = 'opt-in';

describe('Opt-in recommendation mode', () => {
  test('only fields with explicit truthy @UI.RecommendationState are enrolled', async () => {
    const recommendationElements =
      cds.model.definitions['CatalogService.Books_Recommendations'].elements;
    // price carries a plain truthy @UI.RecommendationState
    assert.ok(recommendationElements.price);
    // dynamic expressions count as explicit opt-in
    assert.ok(recommendationElements.authorWDynamicRecommendations_ID);
    // value-help fields without the annotation no longer auto-enroll
    assert.strictEqual('author_ID' in recommendationElements, false);
    assert.strictEqual('genre_ID' in recommendationElements, false);
    assert.strictEqual('currency_code' in recommendationElements, false);
    // @UI.RecommendationState : 0 still excludes
    assert.strictEqual('authorWORecommendations_ID' in recommendationElements, false);
  });

  test('entity with no enrolled fields gets no SAP_Recommendations companion', async () => {
    // BooksWithCustomKey only has value-help fields, none explicitly opted in
    assert.strictEqual(
      'SAP_Recommendations' in cds.model.definitions['CatalogService.BooksWithCustomKey'].elements,
      false
    );
    assert.strictEqual(
      !!cds.model.definitions['CatalogService.BooksWithCustomKey_Recommendations'],
      false
    );
    const { status } = await GET(`/odata/v4/catalog/BooksWithCustomKey`);
    assert.strictEqual(status, 200);
  });

  test('draft READ returns predictions only for opted-in fields', async () => {
    const {
      data: { ID }
    } = await POST(`/odata/v4/catalog/Books`, { ID: Math.round(Math.random() * 10000) });
    const { status, data } = await GET(
      `/odata/v4/catalog/Books(ID=${ID},IsActiveEntity=false)?$expand=SAP_Recommendations`
    );
    assert.strictEqual(status, 200);
    assert.ok(data.SAP_Recommendations);
    assert.ok(data.SAP_Recommendations.price.length);
    assert.strictEqual('author_ID' in data.SAP_Recommendations, false);
    assert.strictEqual('genre_ID' in data.SAP_Recommendations, false);
  });
});
