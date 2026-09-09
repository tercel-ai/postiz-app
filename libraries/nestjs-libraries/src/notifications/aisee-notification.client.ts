import { Injectable, Logger } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import { AiseeCreditService } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee-credit.service';

/**
 * Pushes semantic notification events to the Aisee notification centre.
 *
 * Deliberately mirrors AiseeClient rather than extending it: same JWT_SECRET,
 * same `system-internal` role, same short-lived cached token. Only the event is
 * sent — every string the user sees is rendered on the Aisee side from a
 * registry, so wording changes never require a Postiz deploy.
 *
 * Postiz's own in-app Notifications table and bell are untouched; this is an
 * additional, one-way feed.
 */

/** Event keys owned by Postiz. Must match the Aisee registry exactly. */
export const AiseeNotificationEvent = {
  POST_GENERATED: 'post.generated',
  POST_GENERATION_FAILED: 'post.generation_failed',
  POST_PUBLISHED: 'post.published',
  POST_PUBLISH_FAILED: 'post.publish_failed',
  ENGAGE_GENERATED: 'engage.generated',
  ENGAGE_REPLIED: 'engage.replied',
  ENGAGE_REPLY_FAILED: 'engage.reply_failed',
} as const;

export type AiseeNotificationEvent =
  (typeof AiseeNotificationEvent)[keyof typeof AiseeNotificationEvent];

/** Writing service recorded on the Aisee row, for support triage. */
export const AiseeNotificationChannel = {
  POSTIZ: 'postiz',
  ENGAGE: 'engage',
} as const;

export type AiseeNotificationChannel =
  (typeof AiseeNotificationChannel)[keyof typeof AiseeNotificationChannel];

export interface AiseeNotifyRequest {
  /** Organization the event belongs to; resolved to its owning Aisee user. */
  organizationId: string;
  eventKey: AiseeNotificationEvent;
  /**
   * Idempotency key for this event INSTANCE, e.g. `post.published:{postId}`.
   * Required, and it must identify the instance rather than the type: Temporal
   * replays activities and HTTP calls get retried, so the same emit reaches
   * Aisee more than once as a matter of course.
   */
  dedupKey: string;
  /** Template variables. Must be a self-contained snapshot at emit time. */
  data?: Record<string, unknown>;
  channel?: AiseeNotificationChannel;
}

@Injectable()
export class AiseeNotificationClient {
  private readonly logger = new Logger(AiseeNotificationClient.name);

  private _cachedToken: string | null = null;
  private _tokenExpiresAt = 0;

  constructor(private _aiseeCreditService: AiseeCreditService) {}

  private get baseUrl(): string {
    return process.env.AISEE_ORCHESTRATOR_URL || 'http://localhost:8000';
  }

  public get enabled(): boolean {
    return !!process.env.AISEE_ORCHESTRATOR_URL;
  }

  /**
   * Sign a short-lived system-internal JWT, cached until a minute before expiry.
   * Same scheme as AiseeClient.signInternalToken.
   */
  private signInternalToken(): string {
    const now = Math.floor(Date.now() / 1000);
    if (this._cachedToken && now < this._tokenExpiresAt - 60) {
      return this._cachedToken;
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('JWT_SECRET is not configured');
    }

    const expiresIn = 120; // 2 minutes
    this._cachedToken = sign(
      { roles: ['system-internal'], iss: 'postiz', is_super_user: true },
      secret,
      { expiresIn }
    );
    this._tokenExpiresAt = now + expiresIn;
    return this._cachedToken;
  }

  /**
   * Record a notification for an organization's owner.
   *
   * Never throws and never returns a rejected promise: a notification is a side
   * channel, and the publish or reply that triggered it has already happened.
   * Returns true only when Aisee created a new row — false covers both a
   * deduplicated retry and a delivery failure, neither of which the caller can
   * or should act on.
   */
  async notify(req: AiseeNotifyRequest): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }

    try {
      const userId = await this._aiseeCreditService.resolveOwnerUserId(
        req.organizationId
      );

      const response = await fetch(`${this.baseUrl}/post-agent/notification/emit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.signInternalToken()}`,
        },
        body: JSON.stringify({
          user_id: userId,
          event_key: req.eventKey,
          dedup_key: req.dedupKey,
          data: req.data || {},
          channel: req.channel || AiseeNotificationChannel.POSTIZ,
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        this.logger.error(
          `notify failed: ${response.status} event=${req.eventKey} ` +
            `dedup=${req.dedupKey} body=${body}`
        );
        return false;
      }

      const data = await response.json();
      return !!data?.created;
    } catch (error) {
      this.logger.error(
        `notify error event=${req.eventKey} dedup=${req.dedupKey}:`,
        error
      );
      return false;
    }
  }
}
