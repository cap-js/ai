import cds from '@sap/cds';
const LOG = cds.log('catalog');

export default class CatalogService extends cds.ApplicationService {
	init() {
		const { Books } = this.entities;

		this.on('accept', async (req) => {
			await DELETE(req.subject);
			req.info('Removed chapter');
		});
		// Reduce stock of ordered books if available stock suffices
		this.on('submitOrder', async (req) => {
			const { book, quantity } = req.data;
			let { stock } = await SELECT`stock`.from(Books, book);
			if (stock >= quantity) {
				await UPDATE(Books, book).with(`stock -=`, quantity);
				await this.emit('OrderedBook', { book, quantity, buyer: req.user.id });
				return { stock };
			} else return req.error(409, `${quantity} exceeds stock for book #${book}`);
		});

		this.before('UPDATE', Books.drafts, async (req) => {
			if (req.data.stock < 0) {
				req.warn({
					code: 'IMPOSSIBLE_STOCK',
					message: 'Stocks lower than 0 are not possible!',
					target: 'stock'
				});
			}
		});

		return super.init();
	}
}
