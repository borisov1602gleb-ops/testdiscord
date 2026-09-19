import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireMembership } from '../lib/access.js';

export const communitiesRouter = Router();

communitiesRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) throw new HttpError(400, 'name_required');

    const created = await withTransaction(async (client) => {
      const { rows: communityRows } = await client.query(
        'INSERT INTO communities (name, owner_id) VALUES ($1, $2) RETURNING *',
        [name, req.user.id],
      );
      const community = communityRows[0];

      await client.query(
        `INSERT INTO community_members (community_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [community.id, req.user.id],
      );

      // MVP: каждое сообщество получает ровно один текстовый и один голосовой канал.
      const { rows: channels } = await client.query(
        `INSERT INTO channels (community_id, name, type)
         VALUES ($1, 'general', 'text'), ($1, 'General Voice', 'voice')
         RETURNING *`,
        [community.id],
      );

      return { community, channels };
    });

    res.status(201).json(created);
  }),
);

communitiesRouter.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM communities WHERE id = $1', [req.params.id]);
    if (rows.length === 0) throw new HttpError(404, 'community_not_found');

    const role = await requireMembership(req.user.id, req.params.id);
    const { rows: channels } = await query(
      'SELECT * FROM channels WHERE community_id = $1 ORDER BY type, created_at',
      [req.params.id],
    );

    res.json({ community: rows[0], channels, role });
  }),
);
