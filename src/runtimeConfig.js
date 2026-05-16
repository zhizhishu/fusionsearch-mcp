import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_RUNTIME_CONFIG_PATH = path.join(process.cwd(), 'config', 'runtime.json');

export function getRuntimeConfigPath() {
  return process.env.RUNTIME_CONFIG_PATH || DEFAULT_RUNTIME_CONFIG_PATH;
}

export async function loadRuntimeConfig(configPath = getRuntimeConfigPath()) {
  try {
    const raw = await readFile(configPath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

export async function saveRuntimeConfig(config, configPath = getRuntimeConfigPath()) {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(`${configPath}.tmp`, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await rename(`${configPath}.tmp`, configPath);
}
