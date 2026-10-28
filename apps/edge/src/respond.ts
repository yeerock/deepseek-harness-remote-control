/**
 * Response helpers for pages the edge renders itself. Proxied DSH responses
 * must never pass through here: they keep their own headers and CSP.
 */
import type { ServerResponse } from 'node:http';
import { applySecurityHeaders, sendHtml, sendJson } from '@dsh-rc/shared';
import { errorPage } from './pages.js';

export function sendPage(response: ServerResponse, status: number, html: string, headers: Record<string, string> = {}): void {
  applySecurityHeaders(response);
  sendHtml(response, status, html, headers);
}

export function sendErrorPage(
  response: ServerResponse,
  status: number,
  title: string,
  message: string,
  headers: Record<string, string> = {},
): void {
  sendPage(response, status, errorPage({ status, title, message }), headers);
}

export function sendJsonError(response: ServerResponse, status: number, error: string, message?: string): void {
  sendJson(response, status, message === undefined ? { error } : { error, message });
}