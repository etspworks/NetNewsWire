/**
 * Localized — NSLocalizedString for the .ts service layer.
 *
 * A .ts service cannot use an ArkUI app.string resource reference, so
 * strings are resolved by NAME through the resource manager, with the source's English
 * text as the fallback if the resource is missing or the context is not up yet.
 */

import { hilog } from '@kit.PerformanceAnalysisKit';
import { AppContext } from '../util/AppContext';

const DOMAIN: number = 0x0001;
const TAG: string = 'Localized';

export function localized(resourceName: string, fallback: string): string {
  if (!AppContext.isReady()) {
    return fallback;
  }
  try {
    const value: string = AppContext.get().resourceManager.getStringByNameSync(resourceName);
    return value.length === 0 ? fallback : value;
  } catch (e) {
    hilog.debug(DOMAIN, TAG, 'no string resource named %{public}s', resourceName);
    return fallback;
  }
}
