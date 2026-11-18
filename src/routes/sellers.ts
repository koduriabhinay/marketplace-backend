import { Router } from 'express';
import { authenticate, requireRole } from '../auth/middleware';
import { assertCanManageSeller } from '../auth/policies';
import { parse } from '../lib/validate';
import { idParamSchema } from '../schemas/common';
import { createSellerSchema, listSellersQuerySchema, updateSellerSchema } from '../schemas/seller';
import type { SellerService } from '../services/sellerService';

export function sellersRouter(service: SellerService) {
  const router = Router();

  // Sellers normally sign up via POST /auth/register; this is an admin back-office tool.
  router.post('/', authenticate, requireRole('admin'), async (req, res) => {
    const seller = await service.create(parse(createSellerSchema, req.body));
    res.status(201).location(`${req.baseUrl}/${seller.id}`).json({ data: seller });
  });

  // Seller storefront profiles are public.
  router.get('/', async (req, res) => {
    res.json(await service.list(parse(listSellersQuerySchema, req.query)));
  });

  router.get('/:id', async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    res.json({ data: await service.get(id) });
  });

  router.patch('/:id', authenticate, async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    assertCanManageSeller(req.user!, id);
    res.json({ data: await service.update(id, parse(updateSellerSchema, req.body)) });
  });

  return router;
}
