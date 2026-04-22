import cds from '@sap/cds';
const LOG = cds.log('@cap-js/ai');

export function getProperty(where, property) {
	let res = null;
	if (!where) return null;
	for (let i = 0; i < where.length; i++) {
		const ele = where[i];
		if (
			ele?.val &&
			((where[i - 1] === '=' && where[i - 2]?.ref && where[i - 2]?.ref[0] === property) ||
				(where[i + 1] === '=' && where[i + 2]?.ref && where[i + 2]?.ref[0] === property))
		) {
			res = ele.val;
			return res;
		} else if (ele?.xpr) {
			const val = getProperty(ele.xpr, property);
			if (val) {
				res = val;
				return res;
			}
		}
	}
	return null;
}

export async function parseResponse(req, response) {
	if (response.ok) {
		let res = await response.json();
		if (res.resources) {
			res.resources['$odata.count'] = res.count;
			res = res.resources;
		}
		if (req.query.SELECT?.one) {
			res = Array.isArray(res) ? res[0] : res;
		}
		return res;
	} else {
		const body = response.headers.get('content-type')?.match('json')
			? JSON.stringify(await response.json())
			: response.status;
		LOG.error(
			`Error when requesting ${req.target.name} from AI Core for tenant: `,
			cds.context.tenant,
			req.event,
			req.query,
			body
		);
		return {};
	}
}
