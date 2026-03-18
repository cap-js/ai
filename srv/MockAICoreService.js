import AICoreService from './AICoreService.js';

export default class MockAICore extends AICoreService {
	init() {
		return super.init();
	}
	async _predictRowColumns(req) {
		const {
			prediction_config: { target_columns },
			index_column,
			rows
		} = req.data;
		const predictions = [];
		for (const row of rows) {
			const newPrediction = { [index_column]: row[index_column] };
			let addPrediction = false;
			for (const { name, prediction_placeholder } of target_columns) {
				if (row[name] === prediction_placeholder) {
					addPrediction = true;
					newPrediction[name] = [{ prediction: rows.find((r) => r[name] !== prediction_placeholder && r[name] !== null && r[name] !== undefined)?.[name] ?? rows.find((r) => r[name] !== prediction_placeholder)?.[name] }];
				}
			}
			if (addPrediction) {
				predictions.push(newPrediction);
			}
		}
		return { predictions: predictions };
	}
}
