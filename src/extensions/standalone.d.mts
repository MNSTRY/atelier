export function scaffoldStandaloneProject(options: { directory: string; applicationId?: string }): Promise<{
  directory: string; applicationId: string; mode: 'unbound'; rootAuthority: false; qualified: false;
}>;
