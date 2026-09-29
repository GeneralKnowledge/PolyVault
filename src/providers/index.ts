import type { ProviderConfig } from "../config/types.js";
import { DropboxProvider } from "./dropbox.js";
import { GDriveProvider } from "./gdrive.js";
import { LocalProvider } from "./local.js";
import { OneDriveProvider } from "./onedrive.js";
import { S3Provider } from "./s3.js";
import { WebDavProvider } from "./webdav.js";
import type { CloudProvider } from "./types.js";

export function createProvider(config: ProviderConfig): CloudProvider {
  switch (config.kind) {
    case "local":
      return new LocalProvider(config);
    case "s3":
      return new S3Provider(config);
    case "gdrive":
      return new GDriveProvider(config);
    case "onedrive":
      return new OneDriveProvider(config);
    case "dropbox":
      return new DropboxProvider(config);
    case "webdav":
      return new WebDavProvider(config);
    default: {
      const _exhaustive: never = config;
      throw new Error(`Unknown provider kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export { LocalProvider } from "./local.js";
export { S3Provider } from "./s3.js";
export { GDriveProvider, linkGoogleDrive } from "./gdrive.js";
export { OneDriveProvider, linkOneDrive } from "./onedrive.js";
export { DropboxProvider, linkDropbox } from "./dropbox.js";
export { WebDavProvider } from "./webdav.js";
export type {
  CloudProvider,
  GetObjectResult,
  HeadObjectResult,
  PutObjectInput,
  PutObjectResult,
} from "./types.js";
