import { Router, Response } from 'express';
import { z } from 'zod';
import { OrgService } from '../services/org.service.js';
import { AuthenticatedRequest, authenticateJWT } from '../middleware/auth.js';
import { query } from '../db/connection.js';

export const orgRouter = Router();

const CreateOrgSchema = z.object({
  name: z.string().min(2),
});

const RosterMemberSchema = z.object({
  userId: z.string().min(1),
  email: z.string().email(),
  role: z.enum(['admin', 'member']).optional(),
});

const SyncRosterSchema = z.object({
  roster: z.array(RosterMemberSchema),
});

orgRouter.post('/orgs', authenticateJWT, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const parse = CreateOrgSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.issues });
    return;
  }

  try {
    const org = await OrgService.createOrg(parse.data.name, req.user!.userId);
    res.status(201).json({ org });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

orgRouter.post('/orgs/:id/roster', authenticateJWT, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const parse = SyncRosterSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.issues });
    return;
  }

  try {
    const result = await OrgService.syncRoster(req.params.id as string, parse.data.roster);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

orgRouter.get('/orgs/:id/members', authenticateJWT, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const members = await query('SELECT * FROM org_members WHERE org_id = $1 ORDER BY joined_at ASC', [
      req.params.id,
    ]);
    res.json({ members: members.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
