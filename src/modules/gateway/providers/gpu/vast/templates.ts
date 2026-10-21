/**
 * Vast.ai Template Management
 */

import { createLogger } from '../../../../logger';
import type { VastTemplate, VastCredentials } from './types';
import { vastRequest } from './utils';

const log = createLogger('vast-templates');

/**
 * List all templates
 */
export async function listTemplates(
  credentials: VastCredentials
): Promise<VastTemplate[]> {
  try {
    const response = await vastRequest<{ templates: VastTemplate[] }>(
      '/templates',
      credentials
    );
    return response.templates || [];
  } catch (err) {
    log.error('Failed to list templates:', err);
    throw err;
  }
}

/**
 * Get a specific template
 */
export async function getTemplate(
  templateId: number,
  credentials: VastCredentials
): Promise<VastTemplate | null> {
  try {
    const response = await vastRequest<{ template: VastTemplate }>(
      `/templates/${templateId}`,
      credentials
    );
    return response.template || null;
  } catch (err) {
    log.error(`Failed to get template ${templateId}:`, err);
    return null;
  }
}

/**
 * Create a new template
 */
export async function createTemplate(
  config: {
    name: string;
    image: string;
    imageTag?: string;
    ssh?: boolean;
    jupyter?: boolean;
    direct?: boolean;
    env?: Record<string, string>;
    onstart?: string;
    runtype?: 'args' | 'ssh';
  },
  credentials: VastCredentials
): Promise<{ id: number; success: boolean; error?: string }> {
  try {
    const response = await vastRequest<{ success: boolean; template?: VastTemplate; error?: string }>(
      '/templates/',
      credentials,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: config.name,
          image: config.image,
          image_tag: config.imageTag || 'latest',
          ssh: config.ssh ?? true,
          jupyter: config.jupyter ?? false,
          direct: config.direct ?? true,
          env: config.env || {},
          onstart: config.onstart || '',
          runtype: config.runtype || 'args',
          use_jupyter_lab: false,
        }),
      }
    );
    
    if (!response.success) {
      return { 
        id: 0, 
        success: false, 
        error: response.error || 'Unknown error creating template' 
      };
    }
    
    return { 
      id: response.template?.id || 0, 
      success: true 
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error('Failed to create template:', err);
    return { id: 0, success: false, error: errorMsg };
  }
}

/**
 * Update an existing template
 */
export async function updateTemplate(
  templateId: number,
  updates: Partial<{
    name: string;
    image: string;
    imageTag: string;
    ssh: boolean;
    jupyter: boolean;
    direct: boolean;
    env: Record<string, string>;
    onstart: string;
  }>,
  credentials: VastCredentials
): Promise<boolean> {
  try {
    const response = await vastRequest<{ success: boolean; error?: string }>(
      `/templates/${templateId}/`,
      credentials,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      }
    );
    
    if (!response.success) {
      log.error(`Failed to update template ${templateId}:`, response.error);
      return false;
    }
    
    log.log(`Template ${templateId} updated successfully`);
    return true;
  } catch (err) {
    log.error(`Failed to update template ${templateId}:`, err);
    return false;
  }
}

/**
 * Delete a template
 */
export async function deleteTemplate(
  templateId: number,
  credentials: VastCredentials
): Promise<boolean> {
  try {
    await vastRequest(
      `/templates/${templateId}/`,
      credentials,
      { method: 'DELETE' }
    );
    log.log(`Template ${templateId} deleted successfully`);
    return true;
  } catch (err) {
    log.error(`Failed to delete template ${templateId}:`, err);
    return false;
  }
}
