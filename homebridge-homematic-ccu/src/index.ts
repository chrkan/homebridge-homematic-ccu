import type { API } from 'homebridge';
import { HomematicPlatform } from './platform';
import { PLATFORM_NAME } from './settings';

export = (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, HomematicPlatform);
};
