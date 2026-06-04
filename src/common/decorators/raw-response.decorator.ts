import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE_KEY = 'raw_response';

/** Skip the global { success, message, data } wrapper — used for Python bot passthrough. */
export const RawResponse = () => SetMetadata(RAW_RESPONSE_KEY, true);
