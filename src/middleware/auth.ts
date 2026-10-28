import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AuthUser } from '../types/index.js';

const JWT_SECRET = process.env.JWT_SECRET || 'cornflakes-candidate-secret-key-2026-super-safe';

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
}

export function generateToken(user: AuthUser, expiresIn = '24h'): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn } as any);
}

export function authenticateJWT(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as AuthUser;
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
}

/**
 * IDOR Protection: Checks that user owns the target resource, or has 'admin' role.
 */
export function requireOwnershipOrAdmin(ownerIdExtractor: (req: Request) => string | undefined) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (req.user.role === 'admin') {
      return next();
    }

    const targetOwnerId = ownerIdExtractor(req);
    if (!targetOwnerId || req.user.userId !== targetOwnerId) {
      res.status(403).json({ error: 'Forbidden: IDOR protection violation' });
      return;
    }

    next();
  };
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: 'Forbidden: Admin role required' });
    return;
  }
  next();
}
