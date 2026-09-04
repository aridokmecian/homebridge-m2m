import { API } from "homebridge";
import { PLATFORM_NAME } from "./settings";
import { RControlPlatform } from "./platform";

export = (api: API) => {
    api.registerPlatform(PLATFORM_NAME, RControlPlatform);
};
