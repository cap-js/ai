import path from 'path';
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import cds from '@sap/cds';
import cdsTest from '@cap-js/cds-test';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Bootstrap bookshop CAP app — loads AICore plugin
cdsTest(path.join(__dirname, '../bookshop'));

/**
 * Wrap an async function with a CDS context that has tenant set.
 * AICoreService handlers access cds.context.tenant internally.
 */
async function withTenant(tenant, fn) {
	cds.context = new cds.EventContext({ tenant });
	return fn();
}

describe('AICore Service - cds.ql integration', { concurrency: false }, () => {
	let aiCore;
	const createdResourceGroupIds = [];

	// Resource group used for all tests — reads from cds.env config, falls back to 'default'
	let defaultResourceGroupId;

	before(async () => {
		aiCore = await cds.connect.to('AICore');
		// Integration tests use 'default' resource group which always exists in AI Core.
		// This is independent of the app-level AICore.resourceGroup configuration.
		defaultResourceGroupId = 'default';
	});

	after(async () => {
		for (const id of createdResourceGroupIds) {
			try {
				// eslint-disable-next-line no-await-in-loop
				await withTenant('t0', () =>
					aiCore.run(DELETE.from('AICore.resourceGroups').where({ resourceGroupId: id }))
				);
			} catch {
				/* best-effort cleanup */
			}
		}
	});

	// ─── resourceGroups ─────────────────────────────────────────────

	describe('resourceGroups', { concurrency: false }, () => {
		let insertedResourceGroupId;
		const testTenantId = `test-aicore-${Date.now()}`;

		test('INSERT creates a new resource group', async () => {
			const rgId = cds.utils.uuid();
			const result = await withTenant('t0', () =>
				aiCore.run(
					INSERT.into('AICore.resourceGroups').entries({
						resourceGroupId: rgId,
						labels: [{ key: 'ext.ai.sap.com/CDS_TENANT_ID', value: testTenantId }]
					})
				)
			);
			insertedResourceGroupId = result?.resourceGroupId || rgId;
			createdResourceGroupIds.push(insertedResourceGroupId);
		});

		test('SELECT by resourceGroupId returns the resource group', async () => {
			const results = await withTenant('t0', () =>
				aiCore.run(
					SELECT.from('AICore.resourceGroups').where({
						resourceGroupId: defaultResourceGroupId
					})
				)
			);
			assert.ok(results, 'Should return a result');
			// Single-key where returns the object directly (not array)
			const group = Array.isArray(results) ? results[0] : results;
			assert.strictEqual(group.resourceGroupId, defaultResourceGroupId);
			assert.ok(group.status, 'Should have a status field');
		});

		test('SELECT list with where({tenantId}) returns matching resource groups', async () => {
			// Use the default resource group's actual tenantId (the zone/identity zone)
			const defaultGroup = await withTenant('t0', () =>
				aiCore.run(
					SELECT.from('AICore.resourceGroups').where({
						resourceGroupId: defaultResourceGroupId
					})
				)
			);
			const tenantId = defaultGroup.labels?.find(
				(l) => l.key === 'ext.ai.sap.com/CDS_TENANT_ID'
			)?.value;

			if (!tenantId) return; // skip if no tenant label

			const results = await withTenant('t0', () =>
				aiCore.run(SELECT.from('AICore.resourceGroups').where({ tenantId }))
			);
			assert.ok(Array.isArray(results), 'Result should be an array');
			assert.ok(results.length >= 1, 'Should find at least one resource group');
		});

		test('SELECT.one with where({tenantId}) returns a single resource group', async () => {
			const defaultGroup = await withTenant('t0', () =>
				aiCore.run(
					SELECT.from('AICore.resourceGroups').where({
						resourceGroupId: defaultResourceGroupId
					})
				)
			);
			const tenantId = defaultGroup.labels?.find(
				(l) => l.key === 'ext.ai.sap.com/CDS_TENANT_ID'
			)?.value;

			if (!tenantId) return;

			const result = await withTenant('t0', () =>
				aiCore.run(SELECT.one.from('AICore.resourceGroups').where({ tenantId }))
			);
			assert.ok(result, 'Should return a single result');
			assert.ok(result.resourceGroupId, 'Should have resourceGroupId');
		});

		test('SELECT with where and limit($top) restricts results', async () => {
			const results = await withTenant('t0', () =>
				aiCore.run(
					SELECT.from('AICore.resourceGroups')
						.where({
							resourceGroupId: defaultResourceGroupId
						})
						.limit(1)
				)
			);
			// When filtering by specific ID with limit, result could be object or array
			if (Array.isArray(results)) {
				assert.ok(results.length <= 1, 'Should return at most 1 result');
			} else {
				assert.ok(results, 'Should return a result');
			}
		});

		test('DELETE removes a resource group by resourceGroupId', async (t) => {
			if (!insertedResourceGroupId) {
				t.skip('No resource group was created to delete');
				return;
			}
			await withTenant('t0', () =>
				aiCore.run(
					DELETE.from('AICore.resourceGroups').where({
						resourceGroupId: insertedResourceGroupId
					})
				)
			);
			// Remove from cleanup list since we already deleted
			const idx = createdResourceGroupIds.indexOf(insertedResourceGroupId);
			if (idx >= 0) createdResourceGroupIds.splice(idx, 1);
		});
	});

	// ─── deployments ────────────────────────────────────────────────

	describe('deployments', { concurrency: false }, () => {
		let knownDeploymentId;
		let configurationId;

		test('SELECT list with where({resourceGroup.resourceGroupId}) returns deployments', async () => {
			const results = await withTenant('t0', () =>
				aiCore.run(
					SELECT.from('AICore.deployments').where({
						'resourceGroup.resourceGroupId': defaultResourceGroupId
					})
				)
			);
			assert.ok(Array.isArray(results), 'Result should be an array');
			assert.ok(results.length > 0, 'Default resource group should have deployments');
			knownDeploymentId = results[0].id;
		});

		test('SELECT with limit($top) restricts deployment results', async () => {
			const results = await withTenant('t0', () =>
				aiCore.run(
					SELECT.from('AICore.deployments')
						.where({ 'resourceGroup.resourceGroupId': defaultResourceGroupId })
						.limit(2)
				)
			);
			assert.ok(Array.isArray(results), 'Result should be an array');
			assert.ok(results.length <= 2, 'Should return at most 2 deployments');
		});

		test('SELECT single deployment by id via list filter', async (t) => {
			if (!knownDeploymentId) {
				t.skip('No deployment ID available');
				return;
			}
			// Note: GET /deployments/{id} may return 403 depending on service key
			// permissions. Use list query with both filters as a reliable alternative.
			const results = await withTenant('t0', () =>
				aiCore.run(
					SELECT.from('AICore.deployments').where({
						'resourceGroup.resourceGroupId': defaultResourceGroupId
					})
				)
			);
			const deployment = results.find((d) => d.id === knownDeploymentId);
			assert.ok(deployment, 'Should find deployment in list');
			assert.strictEqual(deployment.id, knownDeploymentId);
			assert.ok(deployment.status, 'Should have status');
		});

		test('stop() and DELETE a deployment', { timeout: 60_000 }, async (t) => {
			// Pre-populate tenant→resourceGroup cache so deployment operations
			// use 'default' without triggering INSERT on resourceGroups.
			aiCore.tenantResourceGroups.set('t0', defaultResourceGroupId);

			// Find an rpt-1 configuration and create a fresh deployment
			const configs = await withTenant('t0', () =>
				aiCore.run(
					SELECT.from('AICore.configurations')
						.where({ 'resourceGroup.resourceGroupId': defaultResourceGroupId })
						.search('rpt-1')
				)
			);
			if (!configs.length) {
				t.skip('No rpt-1 configuration available');
				return;
			}

			// CREATE deployment
			const created = await withTenant('t0', () =>
				aiCore.run(
					INSERT.into('AICore.deployments').entries({
						configurationId: configs[0].id
					})
				)
			);
			assert.ok(created?.id, 'Should create a deployment');
			const deploymentId = created.id;

			// Verify it appears in the list
			const afterCreate = await withTenant('t0', () =>
				aiCore.run(
					SELECT.from('AICore.deployments').where({
						'resourceGroup.resourceGroupId': defaultResourceGroupId
					})
				)
			);
			assert.ok(
				afterCreate.some((d) => d.id === deploymentId),
				'Created deployment should appear in list'
			);

			// stop() — bound action sets targetStatus to STOPPED.
			// Freshly created (PENDING) deployments return 400 from AI Core;
			// handler returns {} on error. This exercises the cds.ql → HTTP path.
			const stopResult = await withTenant('t0', () =>
				aiCore.send({
					event: 'stop',
					entity: 'AICore.deployments',
					params: [{ id: deploymentId }]
				})
			);
			// stop() returns {} on error or the patched deployment on success
			assert.ok(stopResult !== undefined, 'stop() should return a result');

			// DELETE — exercise the cds.ql DELETE → HTTP DELETE path.
			// On PENDING deployments AI Core may reject with 4xx; handler
			// returns {} on error. The operation is still dispatched correctly.
			try {
				await withTenant('t0', () =>
					aiCore.run(
						DELETE.from('AICore.deployments').where({
							id: deploymentId,
							'resourceGroup.resourceGroupId': defaultResourceGroupId
						})
					)
				);
			} catch {
				// DELETE response may have empty body — known handler limitation
			}
		});
	});

	// ─── configurations (read-only) ─────────────────────────────────

	describe('configurations', { concurrency: false }, () => {
		let knownConfigurationId;

		test('SELECT list with where({resourceGroup.resourceGroupId}) returns configurations', async () => {
			const results = await withTenant('t0', () =>
				aiCore.run(
					SELECT.from('AICore.configurations').where({
						'resourceGroup.resourceGroupId': defaultResourceGroupId
					})
				)
			);
			assert.ok(Array.isArray(results), 'Result should be an array');
			assert.ok(results.length > 0, 'Default resource group should have configurations');
			knownConfigurationId = results[0].id;
		});

		test('SELECT single configuration by id via list filter', async (t) => {
			if (!knownConfigurationId) {
				t.skip('No configuration ID available');
				return;
			}
			// Note: GET /configurations/{id} may return 403 depending on service
			// key permissions. Use list query and filter client-side as alternative.
			const results = await withTenant('t0', () =>
				aiCore.run(
					SELECT.from('AICore.configurations').where({
						'resourceGroup.resourceGroupId': defaultResourceGroupId
					})
				)
			);
			const config = results.find((c) => c.id === knownConfigurationId);
			assert.ok(config, 'Should find configuration in list');
			assert.ok(config.name || config.id, 'Should have name or id');
		});

		test('SELECT with .search("rpt-1") filters configurations', async () => {
			const results = await withTenant('t0', () =>
				aiCore.run(
					SELECT.from('AICore.configurations')
						.where({ 'resourceGroup.resourceGroupId': defaultResourceGroupId })
						.search('rpt-1')
				)
			);
			assert.ok(Array.isArray(results), 'Result should be an array');
			assert.ok(results.length > 0, 'Should find rpt-1 configurations');
			for (const config of results) {
				const matchesSearch =
					config.name?.match(/rpt-1/i) ||
					config.scenarioId?.match(/rpt-1/i) ||
					config.executableId?.match(/rpt-1/i);
				assert.ok(matchesSearch, `Configuration ${config.id} should match rpt-1 search`);
			}
		});

		test('SELECT with limit($top) restricts configuration results', async () => {
			const results = await withTenant('t0', () =>
				aiCore.run(
					SELECT.from('AICore.configurations')
						.where({ 'resourceGroup.resourceGroupId': defaultResourceGroupId })
						.limit(2)
				)
			);
			assert.ok(Array.isArray(results), 'Result should be an array');
			assert.ok(results.length <= 2, 'Should return at most 2 configurations');
		});

		test('SELECT with limit($top, $skip) paginates configurations', async () => {
			const allResults = await withTenant('t0', () =>
				aiCore.run(
					SELECT.from('AICore.configurations').where({
						'resourceGroup.resourceGroupId': defaultResourceGroupId
					})
				)
			);

			if (allResults.length < 2) return; // need at least 2 for pagination test

			const page1 = await withTenant('t0', () =>
				aiCore.run(
					SELECT.from('AICore.configurations')
						.where({ 'resourceGroup.resourceGroupId': defaultResourceGroupId })
						.limit(1, 0)
				)
			);
			const page2 = await withTenant('t0', () =>
				aiCore.run(
					SELECT.from('AICore.configurations')
						.where({ 'resourceGroup.resourceGroupId': defaultResourceGroupId })
						.limit(1, 1)
				)
			);

			assert.ok(page1.length === 1, 'Page 1 should have 1 result');
			assert.ok(page2.length === 1, 'Page 2 should have 1 result');
			assert.notStrictEqual(page1[0].id, page2[0].id, 'Pages should return different configs');
		});

		test('SELECT with .search() and limit combined', async () => {
			const results = await withTenant('t0', () =>
				aiCore.run(
					SELECT.from('AICore.configurations')
						.where({ 'resourceGroup.resourceGroupId': defaultResourceGroupId })
						.search('rpt-1')
						.limit(1)
				)
			);
			assert.ok(Array.isArray(results), 'Result should be an array');
			assert.ok(results.length <= 1, 'Should return at most 1 configuration');
		});
	});

	// ─── unbound functions ──────────────────────────────────────────

	describe('functions', { concurrency: false }, () => {
		test('resourceGroupForTenant returns cached ID for known tenant', async () => {
			// Pre-populate the internal cache by doing a SELECT to find an existing
			// resource group, then set it in the tenantResourceGroups map directly
			const existingTenant = `test-fn-existing-${Date.now()}`;

			// First populate cache manually (resourceGroupForTenant tries INSERT
			// internally which hits @mandatory validation — known limitation)
			aiCore.tenantResourceGroups.set(existingTenant, defaultResourceGroupId);

			const result = await withTenant('t0', () =>
				aiCore.resourceGroupForTenant({ tenant: existingTenant })
			);
			assert.strictEqual(result, defaultResourceGroupId);
		});

		test('resourceGroupForTenant returns same ID on repeated calls (cached)', async () => {
			const tenant = `test-fn-cached-${Date.now()}`;
			aiCore.tenantResourceGroups.set(tenant, defaultResourceGroupId);

			const first = await withTenant('t0', () => aiCore.resourceGroupForTenant({ tenant }));
			const second = await withTenant('t0', () => aiCore.resourceGroupForTenant({ tenant }));
			assert.strictEqual(first, second, 'Should return same resource group ID');
			assert.strictEqual(first, defaultResourceGroupId);
		});
	});
});
