import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { TOOLKIT_ROOT } from '../paths';
import {
  JOB_TEMPLATE_SCHEMA_VERSION,
  JobTemplate,
  JobTemplateCatalog,
  JobTemplateIndex,
  isSafeJobTemplateId,
  summarizeJobTemplate,
  validateJobTemplate,
  validateJobTemplateIndex,
} from '../helpers/jobTemplates';

const INDEX_FILENAME = 'index.json';
export const JOB_TEMPLATE_DIRECTORY = path.join(TOOLKIT_ROOT, 'config', 'job_templates');

export class JobTemplateConflictError extends Error {}
export class JobTemplateNotFoundError extends Error {}

const jsonWithNewline = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class JobTemplateStore {
  constructor(private readonly directory = JOB_TEMPLATE_DIRECTORY) {}

  private assertId(id: string) {
    if (!isSafeJobTemplateId(id) || id === 'index' || id === 'default') {
      throw new Error('Template ID must use lowercase letters, numbers, dots, underscores, or hyphens');
    }
  }

  private templatePath(id: string) {
    this.assertId(id);
    return path.join(this.directory, `${id}.json`);
  }

  private async ensureDirectory() {
    await fs.promises.mkdir(this.directory, { recursive: true });
  }

  private async readJson(filePath: string): Promise<unknown> {
    const content = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(content);
  }

  private async writeJsonAtomic(filePath: string, value: unknown) {
    await this.ensureDirectory();
    const temporaryPath = path.join(this.directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await fs.promises.writeFile(temporaryPath, jsonWithNewline(value), 'utf8');
      await fs.promises.rename(temporaryPath, filePath);
    } finally {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  async readIndex(): Promise<JobTemplateIndex> {
    try {
      return validateJobTemplateIndex(await this.readJson(path.join(this.directory, INDEX_FILENAME)));
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return { schema_version: JOB_TEMPLATE_SCHEMA_VERSION, default_template: null };
      }
      throw new Error(`Invalid ${INDEX_FILENAME}: ${errorMessage(error)}`);
    }
  }

  async list(): Promise<JobTemplateCatalog> {
    await this.ensureDirectory();

    let index: JobTemplateIndex;
    const issues: JobTemplateCatalog['issues'] = [];
    try {
      index = await this.readIndex();
    } catch (error) {
      index = { schema_version: JOB_TEMPLATE_SCHEMA_VERSION, default_template: null };
      issues.push({ id: 'index', error: errorMessage(error) });
    }

    const entries = await fs.promises.readdir(this.directory, { withFileTypes: true });
    const templateFiles = entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json') && entry.name !== INDEX_FILENAME)
      .sort((a, b) => a.name.localeCompare(b.name));

    const templates = [];
    for (const entry of templateFiles) {
      const id = entry.name.slice(0, -'.json'.length);
      try {
        this.assertId(id);
        const template = validateJobTemplate(await this.readJson(path.join(this.directory, entry.name)));
        templates.push(summarizeJobTemplate(id, template));
      } catch (error) {
        issues.push({ id, error: errorMessage(error) });
      }
    }

    templates.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    if (index.default_template && !templates.some(template => template.id === index.default_template)) {
      issues.push({ id: 'index', error: `Default template "${index.default_template}" does not exist` });
      index.default_template = null;
    }

    return {
      schema_version: JOB_TEMPLATE_SCHEMA_VERSION,
      default_template: index.default_template,
      templates,
      issues,
    };
  }

  async get(id: string): Promise<JobTemplate> {
    const filePath = this.templatePath(id);
    try {
      return validateJobTemplate(await this.readJson(filePath));
    } catch (error: any) {
      if (error?.code === 'ENOENT') throw new JobTemplateNotFoundError(`Template "${id}" was not found`);
      throw new Error(`Invalid template "${id}": ${errorMessage(error)}`);
    }
  }

  async save(id: string, value: unknown, overwrite = false): Promise<JobTemplate> {
    const template = validateJobTemplate(value);
    const filePath = this.templatePath(id);
    await this.ensureDirectory();

    if (!overwrite) {
      try {
        await fs.promises.writeFile(filePath, jsonWithNewline(template), { encoding: 'utf8', flag: 'wx' });
        return template;
      } catch (error: any) {
        if (error?.code === 'EEXIST') {
          throw new JobTemplateConflictError(`Template "${id}" already exists`);
        }
        throw error;
      }
    }

    await this.writeJsonAtomic(filePath, template);
    return template;
  }

  async setDefault(id: string | null): Promise<JobTemplateIndex> {
    if (id !== null) await this.get(id);
    const index: JobTemplateIndex = {
      schema_version: JOB_TEMPLATE_SCHEMA_VERSION,
      default_template: id,
    };
    await this.writeJsonAtomic(path.join(this.directory, INDEX_FILENAME), index);
    return index;
  }
}

export const getJobTemplateStore = () => new JobTemplateStore();
