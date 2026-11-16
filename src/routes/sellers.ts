import { Router } from 'express';
import { parse } from '../lib/validate';
import { idParamSchema } from '../schemas/common';
import { createSellerSchema, listSellersQuerySchema, updateSellerSchema } from '../schemas/seller';
import type { SellerService } from '../services/sellerService';

export function sellersRouter(service: SellerService) {
  const router = Router();

  router.post('/', async (req, res) => {
    const seller = await service.create(parse(createSellerSchema, req.body));
    res.status(201).location(`${req.baseUrl}/${seller.id}`).json({ data: seller });
  });

  router.get('/', async (req, res) => {
    res.json(await service.list(parse(listSellersQuerySchema, req.query)));
  });

  router.get('/:id', async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    res.json({ data: await service.get(id) });
  });

  router.patch('/:id', async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    res.json({ data: await service.update(id, parse(updateSellerSchema, req.body)) });
  });

  return router;
}
