import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import { SettingsService } from '@gitroom/nestjs-libraries/database/prisma/settings/settings.service';

/** Header every extension build sends from `backendCall`. */
export const EXTENSION_VERSION_HEADER = 'x-aisee-ext-version';

/**
 * Header carrying the floor back to the client, on every served response.
 *
 * Deliberately a header rather than a field on some business endpoint. The floor
 * is a property of the CONTRACT, not of engage config or of a subscription, and
 * a client that is already below it gets 426 from every business endpoint — so
 * the one place a payload could carry it is the one place it cannot be read.
 * A response header is the mirror of the request header and is present on both
 * the served and the refused answer.
 */
export const EXTENSION_MIN_VERSION_HEADER = 'x-aisee-ext-min-version';

/**
 * Settings key holding the minimum extension version the API will serve.
 * Adjustable at runtime, because raising the floor is an operational decision
 * (made when a contract changes) and must not require a deploy.
 */
export const MIN_EXTENSION_VERSION_KEY = 'extension_min_version';

/**
 * The floor when the setting has never been written: the build that introduced
 * the version header itself.
 *
 * Nothing older can state a version at all — an unversioned request is treated
 * as "not the extension" and passes — so this floor refuses exactly the builds
 * that DO announce themselves and are behind. Raising it later is a settings
 * edit, not a deploy.
 */
export const DEFAULT_MIN_EXTENSION_VERSION = '1.10.0';

/**
 * Refuses requests from extension builds older than the configured floor.
 *
 * The problem it solves: the extension runs in browsers nobody controls, on
 * Chrome's update schedule, so at any moment several builds are live. Without a
 * floor the only way to change a contract is to keep serving every old shape
 * forever — every field retired leaves a permanent compatibility shim, and the
 * contract can only ever grow. Asking "has everyone updated yet?" has no answer,
 * so the shim never gets removed.
 *
 * Inverting it: the server states the contract it speaks, and a client too old
 * to speak it is told to update rather than quietly served a shape it will
 * misread. The API then carries exactly one contract.
 *
 * `426 Upgrade Required` is the status HTTP defines for precisely this, and it
 * matters that it is not a 4xx the client might retry-loop on or a 5xx it might
 * read as "the server is broken".
 *
 * **A build too old to understand 426 still fails SAFELY.** It sees an error,
 * publishes nothing, and keeps polling until Chrome updates it — normally within
 * a day or two. The failure direction is "nothing happens", never "the wrong
 * thing happens", which is the only reason a floor can be raised without waiting
 * for the fleet.
 *
 * Requests with no version header pass. Everything that is not the extension —
 * the web app, server-to-server calls — has no version to state, and rejecting
 * them would take out the whole API.
 */
@Injectable()
export class ExtensionVersionGuard implements CanActivate {
  private readonly logger = new Logger(ExtensionVersionGuard.name);

  constructor(private readonly _settings: SettingsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request: Request = context.switchToHttp().getRequest();
    const version = request.headers?.[EXTENSION_VERSION_HEADER];
    if (typeof version !== 'string' || !version) return true;

    const floor = await this._readFloor();
    if (!floor) return true;

    // Tell every extension caller the floor, whether or not it clears it. This
    // is what lets a client warn while it still WORKS: 426 arrives only once the
    // build has already stopped, which is too late to be a warning.
    context.switchToHttp().getResponse()?.setHeader?.(
      EXTENSION_MIN_VERSION_HEADER,
      floor
    );

    if (compareVersions(version, floor) >= 0) return true;

    throw new HttpException(
      {
        code: 'extension_upgrade_required',
        message: `This extension build (${version}) is older than the minimum supported version (${floor}). Update the extension to continue.`,
        minVersion: floor,
        yourVersion: version,
      },
      // 426 Upgrade Required. Not in Nest's HttpStatus enum, which stops at the
      // common codes — the numeric literal is the status itself, not a magic
      // number standing in for one.
      426
    );
  }

  /**
   * Three outcomes, and the difference between two of them is load-bearing:
   *
   *   - a stored value  → that floor;
   *   - nothing stored  → `DEFAULT_MIN_EXTENSION_VERSION`, the intended floor;
   *   - a read FAILURE  → `''`, no floor at all.
   *
   * The last is not the same as the second. Falling back to the default on a
   * failure would let a settings outage start REFUSING clients — a gate that
   * cannot read its own configuration must not enforce it. Nothing behind this
   * gate is protected by it, so failing open costs a stale client one more poll,
   * while failing closed costs every user their automation.
   *
   * An empty stored value is honoured as "no floor" — that is how an operator
   * turns the gate off without deleting the key.
   */
  private async _readFloor(): Promise<string> {
    try {
      const stored = await this._settings.get<string>(MIN_EXTENSION_VERSION_KEY);
      return typeof stored === 'string' ? stored.trim() : DEFAULT_MIN_EXTENSION_VERSION;
    } catch (err) {
      this.logger.warn(
        `Could not read ${MIN_EXTENSION_VERSION_KEY}; serving without a version floor: ${
          err instanceof Error ? err.message : err
        }`
      );
      return '';
    }
  }
}

/**
 * Compare two dotted numeric versions. `-1` / `0` / `1`, the usual way.
 *
 * Deliberately not semver-aware: extension versions are Chrome manifest
 * versions, which are 1-4 dot-separated integers and nothing else — no
 * pre-release tags, no build metadata. Pulling in a semver parser to handle
 * grammar this format cannot express would add a dependency and a second set of
 * edge cases.
 *
 * A segment that is not a number reads as 0. That makes a malformed version
 * compare LOW and get rejected, which is the safe side: a client sending
 * something unparseable is a client that should not be trusted to speak the
 * current contract.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split('.').map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
  const left = parse(a);
  const right = parse(b);
  const width = Math.max(left.length, right.length);
  for (let i = 0; i < width; i++) {
    // Missing segments are 0, so "1.3" and "1.3.0" are the same version.
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}
