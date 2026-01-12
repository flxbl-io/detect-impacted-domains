import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { glob } from 'glob';

const VERSION = '1.0.0';
const ACTION_NAME = 'detect-impacted-domains';

interface ReleaseConfig {
  releaseName: string;
  includeOnlyArtifacts?: string[];
  excludeArtifacts?: string[];
  excludeAllPackageDependencies?: boolean;
  excludePackageDependencies?: string[];
  includeAncillaryArtifacts?: string[];
}

interface SfdxProject {
  packageDirectories: Array<{
    package?: string;
    path: string;
    default?: boolean;
  }>;
}

interface DomainInfo {
  name: string;
  configFile: string;
  packages: string[];
}

interface ImpactedDomain {
  name: string;
  configFile: string;
  changedPackages: string[];
}

function printHeader(baseRef: string, headRef: string): void {
  const line = '-'.repeat(90);
  console.log(line);
  console.log(`flxbl-actions  -- ❤️  by flxbl.io ❤️  -Version:${VERSION}`);
  console.log(line);
  console.log(`Action        : ${ACTION_NAME}`);
  console.log(`Base Ref      : ${baseRef}`);
  console.log(`Head Ref      : ${headRef}`);
  console.log(line);
  console.log();
}

async function getChangedFiles(baseRef: string, headRef: string): Promise<string[]> {
  let stdout = '';

  await exec.exec('git', ['diff', '--name-only', `${baseRef}...${headRef}`], {
    listeners: {
      stdout: (data: Buffer) => {
        stdout += data.toString();
      }
    },
    silent: true,
    ignoreReturnCode: true
  });

  return stdout.trim().split('\n').filter(f => f.length > 0);
}

function loadSfdxProject(projectPath: string): SfdxProject {
  const content = fs.readFileSync(projectPath, 'utf8');
  return JSON.parse(content) as SfdxProject;
}

function loadReleaseConfig(configPath: string): ReleaseConfig {
  const content = fs.readFileSync(configPath, 'utf8');
  return yaml.load(content) as ReleaseConfig;
}

function getPackagesInDomain(releaseConfig: ReleaseConfig, sfdxProject: SfdxProject): string[] {
  const allPackages = sfdxProject.packageDirectories
    .filter(dir => dir.package)
    .map(dir => dir.package as string);

  if (releaseConfig.includeOnlyArtifacts && releaseConfig.includeOnlyArtifacts.length > 0) {
    // Only include specified packages
    return releaseConfig.includeOnlyArtifacts.filter(pkg => allPackages.includes(pkg));
  }

  // Start with all packages, then exclude
  let packages = [...allPackages];

  if (releaseConfig.excludeArtifacts) {
    packages = packages.filter(pkg => !releaseConfig.excludeArtifacts!.includes(pkg));
  }

  return packages;
}

function getPackagePath(packageName: string, sfdxProject: SfdxProject): string | null {
  const dir = sfdxProject.packageDirectories.find(d => d.package === packageName);
  return dir ? dir.path : null;
}

function isFileInPackage(filePath: string, packagePath: string): boolean {
  const normalizedFilePath = filePath.replace(/\\/g, '/');
  const normalizedPackagePath = packagePath.replace(/\\/g, '/');
  return normalizedFilePath.startsWith(normalizedPackagePath + '/') ||
         normalizedFilePath === normalizedPackagePath;
}

function detectImpactedDomains(
  domains: DomainInfo[],
  changedFiles: string[],
  sfdxProject: SfdxProject
): ImpactedDomain[] {
  const impacted: ImpactedDomain[] = [];

  for (const domain of domains) {
    const changedPackages: string[] = [];

    for (const pkg of domain.packages) {
      const pkgPath = getPackagePath(pkg, sfdxProject);
      if (pkgPath) {
        const hasChanges = changedFiles.some(file => isFileInPackage(file, pkgPath));
        if (hasChanges) {
          changedPackages.push(pkg);
        }
      }
    }

    if (changedPackages.length > 0) {
      impacted.push({
        name: domain.name,
        configFile: domain.configFile,
        changedPackages
      });
    }
  }

  return impacted;
}

export async function run(): Promise<void> {
  try {
    const releaseConfigPath = core.getInput('release-config-path') || 'config/release-config-*.yaml';
    const baseRef = core.getInput('base-ref') || 'origin/main';
    const headRef = core.getInput('head-ref') || 'HEAD';
    const sfdxProjectPath = core.getInput('sfdx-project-path') || 'sfdx-project.json';

    printHeader(baseRef, headRef);

    // Load sfdx-project.json
    if (!fs.existsSync(sfdxProjectPath)) {
      throw new Error(`sfdx-project.json not found at: ${sfdxProjectPath}`);
    }
    const sfdxProject = loadSfdxProject(sfdxProjectPath);
    core.info(`Loaded sfdx-project.json with ${sfdxProject.packageDirectories.length} package directories`);

    // Find all release config files
    const configFiles = await glob(releaseConfigPath);
    if (configFiles.length === 0) {
      core.warning(`No release config files found matching: ${releaseConfigPath}`);
      core.setOutput('has-changes', 'false');
      core.setOutput('impacted-domains', '[]');
      core.setOutput('matrix', '{"include":[]}');
      return;
    }
    core.info(`Found ${configFiles.length} release config file(s)`);

    // Load all domains
    const domains: DomainInfo[] = [];
    for (const configFile of configFiles) {
      try {
        const config = loadReleaseConfig(configFile);
        const packages = getPackagesInDomain(config, sfdxProject);
        domains.push({
          name: config.releaseName,
          configFile,
          packages
        });
        core.info(`  - ${config.releaseName}: ${packages.length} packages (${configFile})`);
      } catch (error) {
        core.warning(`Failed to load release config: ${configFile}`);
      }
    }

    if (domains.length === 0) {
      core.warning('No valid release configs found');
      core.setOutput('has-changes', 'false');
      core.setOutput('impacted-domains', '[]');
      core.setOutput('matrix', '{"include":[]}');
      return;
    }

    // Get changed files
    core.info('');
    core.info(`Detecting changes between ${baseRef} and ${headRef}...`);
    const changedFiles = await getChangedFiles(baseRef, headRef);
    core.info(`Found ${changedFiles.length} changed file(s)`);

    if (changedFiles.length === 0) {
      core.info('No changes detected');
      core.setOutput('has-changes', 'false');
      core.setOutput('impacted-domains', '[]');
      core.setOutput('matrix', '{"include":[]}');
      return;
    }

    // Detect impacted domains
    core.info('');
    core.info('Analyzing impacted domains...');
    const impactedDomains = detectImpactedDomains(domains, changedFiles, sfdxProject);

    if (impactedDomains.length === 0) {
      core.info('No domains impacted by the changes');
      core.setOutput('has-changes', 'false');
      core.setOutput('impacted-domains', '[]');
      core.setOutput('matrix', '{"include":[]}');
      return;
    }

    // Output results
    core.info('');
    core.info('Impacted domains:');
    for (const domain of impactedDomains) {
      core.info(`  - ${domain.name}: ${domain.changedPackages.join(', ')}`);
    }

    const domainNames = impactedDomains.map(d => d.name);
    const matrix = {
      include: impactedDomains.map(d => ({
        domain: d.name,
        'release-config': d.configFile
      }))
    };

    core.setOutput('has-changes', 'true');
    core.setOutput('impacted-domains', JSON.stringify(domainNames));
    core.setOutput('matrix', JSON.stringify(matrix));

    // Summary
    console.log('');
    const line = '-'.repeat(90);
    console.log(line);
    console.log('Detection Summary');
    console.log(line);
    console.log(`Changed files : ${changedFiles.length}`);
    console.log(`Total domains : ${domains.length}`);
    console.log(`Impacted      : ${impactedDomains.length}`);
    console.log(`Domains       : ${domainNames.join(', ')}`);
    console.log(line);

  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed('Unknown error occurred');
    }
  }
}

if (require.main === module) {
  run();
}
