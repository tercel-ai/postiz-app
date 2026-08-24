import { Injectable, Logger } from '@nestjs/common';
import { UsersRepository } from '@gitroom/nestjs-libraries/database/prisma/users/users.repository';
import { Provider } from '@prisma/client';
import { UserDetailDto } from '@gitroom/nestjs-libraries/dtos/users/user.details.dto';
import { EmailNotificationsDto } from '@gitroom/nestjs-libraries/dtos/users/email-notifications.dto';
import { OrganizationRepository } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.repository';
import { AiseeClient } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee.client';
import { PostPlanLimitsService } from '@gitroom/nestjs-libraries/database/prisma/posts/post-plan-limits.service';

/**
 * Statuses aisee-core defines as a valid subscription that may spend credits —
 * mirrors UserCreditPackageStatus.is_valid_subscription in aisee-core
 * (aisee_shared/models/user_credit_package.py). Kept as raw strings because
 * that is the wire format `AiseeUserCreditPackage.status` carries.
 *
 * CANCELLING is valid on purpose: the user cancelled for the END of the period
 * and has paid through it. PAST_DUE likewise: Stripe is still retrying.
 */
const VALID_SUBSCRIPTION_STATUSES = new Set([
  'active',
  'trialing',
  'past_due',
  'cancelling',
]);

/**
 * How long a package whose status is still valid may outlive its periodEnd.
 * Covers normal webhook delivery lag at renewal (and Stripe's dunning retries
 * on PAST_DUE) without serving a paid plan indefinitely off a record whose
 * renewal silently failed.
 */
const RENEWAL_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private _usersRepository: UsersRepository,
    private _organizationRepository: OrganizationRepository,
    private _aiseeClient: AiseeClient,
    private _postPlanLimits: PostPlanLimitsService
  ) {}

  getUserByEmail(email: string) {
    return this._usersRepository.getUserByEmail(email);
  }

  getUserById(id: string) {
    return this._usersRepository.getUserById(id);
  }

  getImpersonateUser(name: string) {
    return this._organizationRepository.getImpersonateUser(name);
  }

  getUserByProvider(providerId: string, provider: Provider) {
    return this._usersRepository.getUserByProvider(providerId, provider);
  }

  activateUser(id: string) {
    return this._usersRepository.activateUser(id);
  }

  updatePassword(id: string, password: string) {
    return this._usersRepository.updatePassword(id, password);
  }

  getPersonal(userId: string) {
    return this._usersRepository.getPersonal(userId);
  }

  changePersonal(userId: string, body: UserDetailDto) {
    return this._usersRepository.changePersonal(userId, body);
  }

  getEmailNotifications(userId: string) {
    return this._usersRepository.getEmailNotifications(userId);
  }

  updateEmailNotifications(userId: string, body: EmailNotificationsDto) {
    return this._usersRepository.updateEmailNotifications(userId, body);
  }

  // The hard-block sentinel carries an explicit `noActiveSubscription` marker:
  // downstream gates must block on the MARKER, never on `postSendLimit === 0`,
  // because 0 on an active package is a legitimate value ("zero free posts —
  // every post is overage-charged"). On the active member the limits come from
  // post_plan_limits (Settings), where null = no limit.
  async getUserLimits(userId: string): Promise<
    | { postChannelLimit: number; postSendLimit: number; noActiveSubscription: true }
    | { postChannelLimit: number | null; postSendLimit: number | null; periodStart: string; periodEnd: string; name: string; status: string; interval: string; plan?: string }
    | null
  > {
    if (!this._aiseeClient.enabled) {
      return null;
    }

    const pkg = await this._aiseeClient.getUserCreditPackage(userId);

    // API failed or no active package — hard block
    if (pkg === null) {
      this.logger.warn(`No credit package for user=${userId}, blocking channels and posts`);
      return { postChannelLimit: 0, postSendLimit: 0, noActiveSubscription: true };
    }

    // aisee-core owns the answer to "is this subscription valid" — see
    // UserCreditPackageStatus.is_valid_subscription (user_credit_package.py).
    // Re-deriving it here from periodEnd contradicted it: PAST_DUE means
    // "payment failed, Stripe is RETRYING", and its period is always past by
    // definition, so a periodEnd test cut off exactly the users aisee-core says
    // to keep serving. Read the status it already sends us instead.
    if (!VALID_SUBSCRIPTION_STATUSES.has(String(pkg.status).toLowerCase())) {
      this.logger.warn(`Credit package status=${pkg.status} for user=${userId}, blocking channels and posts`);
      return { postChannelLimit: 0, postSendLimit: 0, noActiveSubscription: true };
    }

    // periodEnd is now a staleness backstop rather than the verdict. Renewal
    // lands via a Stripe webhook that arrives AFTER periodEnd (minutes to
    // hours), so a package briefly outliving its period is the normal path, not
    // an expiry — the old check downgraded every paying user in that window.
    // Past the grace window, though, a still-valid status means aisee-core
    // neither renewed nor expired the record (a missed renewal webhook), and a
    // paid plan must not be served forever off a record nothing is maintaining.
    const periodEndMs = pkg.periodEnd ? new Date(pkg.periodEnd).getTime() : NaN;
    if (Number.isNaN(periodEndMs) || periodEndMs + RENEWAL_GRACE_MS < Date.now()) {
      this.logger.error(
        `Credit package status=${pkg.status} but periodEnd=${pkg.periodEnd} is beyond the renewal grace window for user=${userId} — renewal likely missed; blocking channels and posts`
      );
      return { postChannelLimit: 0, postSendLimit: 0, noActiveSubscription: true };
    }

    // post_plan_limits (Settings) REPLACES the package's raw numbers once the
    // plan resolves (null = no limit), so admin-tuned quotas apply everywhere
    // getUserLimits feeds: the permissions gate, overage deduction, dashboard,
    // and user-facing limits. The hard blocks above are intentionally NOT
    // overridable; aisee numbers remain only as the unresolvable-plan fallback.
    return this._postPlanLimits.applyOverrides(pkg);
  }

}
