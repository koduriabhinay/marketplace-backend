import { Router } from 'express';
import { parse } from '../lib/validate';
import { idParamSchema } from '../schemas/common';
import { createListingSchema, listListingsQuerySchema, updateListingSchema } from '../schemas/listing';
import type { ListingService } from '../services/listingService';

export function listingsRouter(service: ListingService) {
  const router = Router();

  router.post('/', async (req, res) => {
    const listing = await service.create(parse(createListingSchema, req.body));
    res.status(201).location(`${req.baseUrl}/${listing.id}`).json({ data: listing });
  });

  router.get('/', async (req, res) => {
    res.json(await service.list(parse(listListingsQuerySchema, req.query)));
  });

  router.get('/:id', async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    res.json({ data: await service.get(id) });
  });

  router.patch('/:id', async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    res.json({ data: await service.update(id, parse(updateListingSchema, req.body)) });
  });

  router.delete('/:id', async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    await service.remove(id);
    res.status(204).end();
  });

  return router;
}
