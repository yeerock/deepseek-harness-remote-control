/**
 * The dsh-rc block of a DeepSeek Harness profile's cordis.patch.yml.
 *
 * Every value is written as a JSON string. JSON strings are valid YAML
 * double-quoted scalars with backslashes escaped, so a Windows path such as
 * C:\Users\admin\dsh-rc\... can never turn into a YAML escape (`\U` starts a
 * Unicode escape and made DeepSeek Harness refuse to start).
 */
export function dshRcPatchEntry({ edge, deviceName, agentEntry }) {
  // JSON leaves DEL and C1 controls raw; YAML rejects them as non-printable, so escape those too.
  const q = (value) => JSON.stringify(String(value)).replace(/[\x7f-\x9f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return [
    '- id: dsh-rc',
    '  config:',
    '    enabled: true',
    `    edgeUrl: ${q(edge)}`,
    `    deviceName: ${q(deviceName.replace(/[\r\n"]/g, ''))}`,
    '    autoStart: true',
    `    agentEntry: ${q(agentEntry)}`,
    '    logLevel: info',
    '',
  ].join('\n');
}
