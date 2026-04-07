export function getProperty(where, property) {
	let res = null;
	for (let i = 0; i < where.length; i++) {
		const ele = where[i];
		if (
			ele?.val &&
			((where[i - 2]?.ref && where[i - 2]?.ref[0] === property) ||
				(where[i + 2]?.ref && where[i + 2]?.ref[0] === property))
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
