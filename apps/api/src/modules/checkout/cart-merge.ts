import { hashToken } from '../../platform/auth.js';
import type { Tx } from '../../platform/db.js';

/**
 * Merge guest cart into the user's cart on login (AC-M02-1, AC-X01).
 * Rule: per offer, resulting qty = max(guest qty, user qty) — re-adding the same item on two devices
 * never silently doubles it. Guest cart becomes 'merged'.
 */
export async function mergeGuestCart(tx: Tx, guestToken: string | null, userId: string): Promise<void> {
  if (!guestToken) return;
  const guest = await tx.query(`SELECT id FROM carts WHERE guest_token_hash=$1 AND status='active' AND user_id IS NULL FOR UPDATE`, [hashToken(guestToken)]);
  if (!guest.rowCount) return;
  const guestId = guest.rows[0].id as string;
  let user = await tx.query(`SELECT id FROM carts WHERE user_id=$1 AND status='active' FOR UPDATE`, [userId]);
  if (!user.rowCount) {
    // Adopt the guest cart as the user's cart.
    await tx.query(`UPDATE carts SET user_id=$2, guest_token_hash=NULL, version=version+1, updated_at=now() WHERE id=$1`, [guestId, userId]);
    return;
  }
  const userCartId = user.rows[0].id as string;
  await tx.query(
    `INSERT INTO cart_lines (cart_id, offer_id, qty)
     SELECT $2, offer_id, qty FROM cart_lines WHERE cart_id=$1
     ON CONFLICT (cart_id, offer_id) DO UPDATE SET qty = GREATEST(cart_lines.qty, EXCLUDED.qty)`,
    [guestId, userCartId],
  );
  await tx.query(`UPDATE carts SET status='merged', user_id=$2, guest_token_hash=NULL, updated_at=now() WHERE id=$1`, [guestId, userId]);
  await tx.query(`UPDATE carts SET version=version+1, updated_at=now() WHERE id=$1`, [userCartId]);
}
