import { API } from "homebridge";
import { PLATFORM_NAME } from "./settings";
import { M2MPlatform } from "./platform";

export = (api: API) => {
    api.registerPlatform(PLATFORM_NAME, M2MPlatform);
};
