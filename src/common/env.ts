import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

type EnvOptions = {
  allowEmpty?: boolean;
};

let cachedEnv: Record<string, string> | null = null;

function parseEnvFile(content: string) {
  const parsed: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key) {
      continue;
    }

    const value = line
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');

    parsed[key] = value;
  }

  return parsed;
}

function loadFileEnv() {
  if (cachedEnv) {
    return cachedEnv;
  }

  const candidatePaths = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), 'api', '.env'),
    resolve(__dirname, '../../.env'),
  ];

  const merged: Record<string, string> = {};
  const seenPaths = new Set<string>();

  for (const filePath of candidatePaths) {
    if (seenPaths.has(filePath) || !existsSync(filePath)) {
      continue;
    }

    seenPaths.add(filePath);
    Object.assign(merged, parseEnvFile(readFileSync(filePath, 'utf8')));
  }

  cachedEnv = merged;
  return merged;
}

export function getEnvValue(
  key: string,
  fallback = '',
  options: EnvOptions = {},
) {
  const allowEmpty = options.allowEmpty ?? false;
  const processValue = process.env[key];
  if (processValue !== undefined) {
    const trimmed = processValue.trim();
    if (trimmed || allowEmpty) {
      return trimmed;
    }
  }

  const fileValue = loadFileEnv()[key];
  if (fileValue !== undefined) {
    const trimmed = fileValue.trim();
    if (trimmed || allowEmpty) {
      return trimmed;
    }
  }

  return fallback;
}

export function getEnvNumber(key: string, fallback: number) {
  const value = getEnvValue(key, '');
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
