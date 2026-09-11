/**
 * CacheControlInfo — port of Modules/RSWeb/Sources/RSWeb/CacheControlInfo.swift
 *
 * Just the part NetNewsWire needs: when the response arrived (dateCreated) and when the
 * feed may be asked again (canResume). maxAge is in seconds, as TimeInterval is.
 */

export class CacheControlInfo {
  readonly dateCreated: Date;
  readonly maxAge: number;

  constructor(dateCreated: Date, maxAge: number) {
    this.dateCreated = dateCreated;
    this.maxAge = maxAge;
  }

  resumeDate(): Date {
    return new Date(this.dateCreated.getTime() + this.maxAge * 1000);
  }

  canResume(): boolean {
    return Date.now() >= this.resumeDate().getTime();
  }

  /**
   * canResume with a ceiling on maxAge — sites misconfigure max-age (feeds seen with a
   * full year), which is clearly not intentional.
   */
  canResumeWithMaxMaxAge(maxMaxAge: number): boolean {
    const maxAgeToUse: number = Math.min(maxMaxAge, this.maxAge);
    return Date.now() >= this.dateCreated.getTime() + maxAgeToUse * 1000;
  }

  equals(other: CacheControlInfo): boolean {
    return this.dateCreated.getTime() === other.dateCreated.getTime()
      && this.maxAge === other.maxAge;
  }

  /** Returns undefined when there is no max-age, or it is < 1. */
  static fromHeaderValue(value: string): CacheControlInfo | undefined {
    const maxAge: number | undefined = CacheControlInfo.parseMaxAge(value);
    if (maxAge === undefined) {
      return undefined;
    }
    return new CacheControlInfo(new Date(), maxAge);
  }

  private static parseMaxAge(s: string): number | undefined {
    const components: string[] = s.split(',');
    for (const component of components) {
      const trimmed: string = component.trim();
      if (trimmed.startsWith('max-age=')) {
        const timeInterval: number = Number.parseFloat(trimmed.substring('max-age='.length));
        if (!Number.isNaN(timeInterval) && timeInterval > 0) {
          return timeInterval;
        }
      }
    }
    return undefined;
  }
}
