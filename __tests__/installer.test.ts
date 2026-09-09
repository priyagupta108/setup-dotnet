import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest
} from '@jest/globals';
import each from 'jest-each';
import semver from 'semver';
import fspromises from 'fs/promises';
import type {Stats} from 'fs';
import os from 'os';
import path from 'path';

jest.unstable_mockModule('@actions/exec', () => ({
  getExecOutput: jest.fn()
}));
jest.unstable_mockModule('@actions/core', () => ({
  warning: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  setOutput: jest.fn(),
  exportVariable: jest.fn((name: string, val: string) => {
    process.env[name] = val;
  }),
  addPath: jest.fn((p: string) => {
    process.env['PATH'] = `${p}${path.delimiter}${process.env['PATH']}`;
  })
}));
jest.unstable_mockModule('@actions/io', () => ({
  which: jest.fn()
}));
jest.unstable_mockModule('fs', () => {
  const actual = jest.requireActual('fs') as typeof import('fs');
  const chmodSync = jest.fn();
  const lstatSync = jest.fn(actual.lstatSync);
  const mkdtempSync = jest.fn(actual.mkdtempSync);
  const rmSync = jest.fn(actual.rmSync);
  return {
    ...actual,
    chmodSync,
    lstatSync,
    mkdtempSync,
    rmSync,
    default: {...actual, chmodSync, lstatSync, mkdtempSync, rmSync}
  };
});

// Allows tests to re-import the installer as if running on another OS.
let platformOverride: 'windows' | 'linux' | 'mac' | undefined;
jest.unstable_mockModule('../src/utils.js', () => ({
  IS_WINDOWS: process.platform === 'win32',
  PLATFORM:
    platformOverride ??
    (process.platform === 'win32'
      ? 'windows'
      : process.platform === 'linux'
        ? 'linux'
        : 'mac')
}));

const exec = await import('@actions/exec');
const core = await import('@actions/core');
const io = await import('@actions/io');
const fs = await import('fs');
const installer = await import('../src/installer.js');
const {IS_WINDOWS} = await import('../src/utils.js');

describe('installer tests', () => {
  const env = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {...env};
    (core.exportVariable as jest.Mock).mockImplementation(
      (...args: unknown[]) => {
        const [name, val] = args as [string, string];
        process.env[name] = val;
      }
    );
    (core.addPath as jest.Mock).mockImplementation((...args: unknown[]) => {
      const [p] = args as [string];
      process.env['PATH'] = `${p}${path.delimiter}${process.env['PATH']}`;
    });
  });

  describe('DotnetCoreInstaller tests', () => {
    const getExecOutputSpy = exec.getExecOutput as jest.Mock;
    const warningSpy = core.warning as jest.Mock;
    const whichSpy = io.which as jest.Mock;
    const maxSatisfyingSpy = jest.spyOn(semver, 'maxSatisfying');
    const chmodSyncSpy = fs.chmodSync as jest.Mock;
    const readdirSpy = jest.spyOn(fspromises, 'readdir');

    describe('installDotnet() tests', () => {
      beforeAll(() => {
        whichSpy.mockImplementation(() => Promise.resolve('PathToShell'));
        chmodSyncSpy.mockImplementation(() => {});
        readdirSpy.mockImplementation(() => Promise.resolve([]));
      });

      afterAll(() => {
        jest.resetAllMocks();
      });

      it('should throw the error in case of non-zero exit code of the installation script. The error message should contain logs.', async () => {
        const inputVersion = '10.0.101';
        const inputQuality = '';
        const errorMessage = 'fictitious error message!';

        getExecOutputSpy.mockImplementation(() => {
          return Promise.resolve({
            exitCode: 1,
            stdout: '',
            stderr: errorMessage
          });
        });

        const dotnetInstaller = new installer.DotnetCoreInstaller(
          inputVersion,
          inputQuality
        );
        await expect(dotnetInstaller.installDotnet()).rejects.toThrow(
          `Failed to install dotnet, exit code: 1. ${errorMessage}`
        );
      });

      it('should return version of .NET SDK after installation complete', async () => {
        const inputVersion = '10.0.101';
        const inputQuality = '';
        const stdout = `Fictitious dotnet version ${inputVersion} is installed`;
        getExecOutputSpy.mockImplementation(() => {
          return Promise.resolve({
            exitCode: 0,
            stdout: `${stdout}`,
            stderr: ''
          });
        });
        maxSatisfyingSpy.mockImplementation(() => inputVersion);

        const dotnetInstaller = new installer.DotnetCoreInstaller(
          inputVersion,
          inputQuality
        );
        const installedVersion = await dotnetInstaller.installDotnet();

        expect(installedVersion).toBe(inputVersion);
      });

      it(`should supply 'version' argument to the installation script if supplied version is in A.B.C syntax`, async () => {
        const inputVersion = '10.0.101';
        const inputQuality = '';
        const stdout = `Fictitious dotnet version ${inputVersion} is installed`;

        getExecOutputSpy.mockImplementation(() => {
          return Promise.resolve({
            exitCode: 0,
            stdout: `${stdout}`,
            stderr: ''
          });
        });
        maxSatisfyingSpy.mockImplementation(() => inputVersion);

        const dotnetInstaller = new installer.DotnetCoreInstaller(
          inputVersion,
          inputQuality
        );

        await dotnetInstaller.installDotnet();

        /**
         * First time script would be called to
         * install runtime, here we checking only the
         * second one that installs actual SDK. i.e. 1
         */
        const callIndex = 1;

        const scriptArguments = (
          getExecOutputSpy.mock.calls[callIndex][1] as string[]
        ).join(' ');
        const expectedArgument = IS_WINDOWS
          ? `-Version ${inputVersion}`
          : `--version ${inputVersion}`;

        expect(scriptArguments).toContain(expectedArgument);
      });

      it(`should warn if the 'quality' input is set and the supplied version is in A.B.C syntax`, async () => {
        const inputVersion = '10.0.101';
        const inputQuality = 'ga';
        const stdout = `Fictitious dotnet version ${inputVersion} is installed`;
        getExecOutputSpy.mockImplementation(() => {
          return Promise.resolve({
            exitCode: 0,
            stdout: `${stdout}`,
            stderr: ''
          });
        });
        maxSatisfyingSpy.mockImplementation(() => inputVersion);

        const dotnetInstaller = new installer.DotnetCoreInstaller(
          inputVersion,
          inputQuality
        );

        await dotnetInstaller.installDotnet();

        expect(warningSpy).toHaveBeenCalledWith(
          `The 'dotnet-quality' input can be used only with .NET SDK version in A.B, A.B.x, A, A.x and A.B.Cxx formats where the major tag is higher than 5. You specified: ${inputVersion}. 'dotnet-quality' input is ignored.`
        );
      });

      it(`should warn if the 'quality' input is set and version isn't in A.B.C syntax but major tag is lower then 6`, async () => {
        const inputVersion = '3.1';
        const inputQuality = 'ga';
        const stdout = `Fictitious dotnet version ${inputVersion} is installed`;

        getExecOutputSpy.mockImplementation(() => {
          return Promise.resolve({
            exitCode: 0,
            stdout: `${stdout}`,
            stderr: ''
          });
        });
        maxSatisfyingSpy.mockImplementation(() => inputVersion);

        const dotnetInstaller = new installer.DotnetCoreInstaller(
          inputVersion,
          inputQuality
        );

        await dotnetInstaller.installDotnet();

        expect(warningSpy).toHaveBeenCalledWith(
          `The 'dotnet-quality' input can be used only with .NET SDK version in A.B, A.B.x, A, A.x and A.B.Cxx formats where the major tag is higher than 5. You specified: ${inputVersion}. 'dotnet-quality' input is ignored.`
        );
      });

      each(['10', '10.0', '10.0.x', '10.0.*', '10.0.X']).test(
        `should supply 'quality' argument to the installation script if quality input is set and version (%s) is not in A.B.C syntax`,
        async inputVersion => {
          const inputQuality = 'ga';
          const exitCode = 0;
          const stdout = `Fictitious dotnet version ${inputVersion} is installed`;
          getExecOutputSpy.mockImplementation(() => {
            return Promise.resolve({
              exitCode: exitCode,
              stdout: `${stdout}`,
              stderr: ''
            });
          });
          maxSatisfyingSpy.mockImplementation(() => inputVersion);

          const dotnetInstaller = new installer.DotnetCoreInstaller(
            inputVersion,
            inputQuality
          );

          await dotnetInstaller.installDotnet();

          /**
           * First time script would be called to
           * install runtime, here we checking only the
           * second one that installs actual SDK. i.e. 1
           */
          const callIndex = 1;

          const scriptArguments = (
            getExecOutputSpy.mock.calls[callIndex][1] as string[]
          ).join(' ');
          const expectedArgument = IS_WINDOWS
            ? `-Quality ${inputQuality}`
            : `--quality ${inputQuality}`;

          expect(scriptArguments).toContain(expectedArgument);
        }
      );

      each(['10', '10.0', '10.0.x', '10.0.*', '10.0.X']).test(
        `should supply 'channel' argument to the installation script if version (%s) isn't in A.B.C syntax`,
        async inputVersion => {
          const inputQuality = '';
          const exitCode = 0;
          const stdout = `Fictitious dotnet version ${inputVersion} is installed`;
          getExecOutputSpy.mockImplementation(() => {
            return Promise.resolve({
              exitCode: exitCode,
              stdout: `${stdout}`,
              stderr: ''
            });
          });
          maxSatisfyingSpy.mockImplementation(() => inputVersion);

          const dotnetInstaller = new installer.DotnetCoreInstaller(
            inputVersion,
            inputQuality
          );

          await dotnetInstaller.installDotnet();

          /**
           * First time script would be called to
           * install runtime, here we checking only the
           * second one that installs actual SDK. i.e. 1
           */
          const callIndex = 1;

          const scriptArguments = (
            getExecOutputSpy.mock.calls[callIndex][1] as string[]
          ).join(' ');
          const expectedArgument = IS_WINDOWS
            ? `-Channel 10.0`
            : `--channel 10.0`;

          expect(scriptArguments).toContain(expectedArgument);
        }
      );

      if (IS_WINDOWS) {
        it(`should supply '-ProxyAddress' argument to the installation script if env.variable 'https_proxy' is set`, async () => {
          process.env['https_proxy'] = 'https://proxy.com';
          const inputVersion = '10.0.101';
          const inputQuality = '';
          const stdout = `Fictitious dotnet version ${inputVersion} is installed`;

          getExecOutputSpy.mockImplementation(() => {
            return Promise.resolve({
              exitCode: 0,
              stdout: `${stdout}`,
              stderr: ''
            });
          });
          maxSatisfyingSpy.mockImplementation(() => inputVersion);

          const dotnetInstaller = new installer.DotnetCoreInstaller(
            inputVersion,
            inputQuality
          );

          await dotnetInstaller.installDotnet();

          /**
           * First time script would be called to
           * install runtime, here we checking only the
           * second one that installs actual SDK. i.e. 1
           */
          const callIndex = 1;

          const scriptArguments = (
            getExecOutputSpy.mock.calls[callIndex][1] as string[]
          ).join(' ');

          expect(scriptArguments).toContain(
            `-ProxyAddress ${process.env['https_proxy']}`
          );
        });

        it(`should supply '-ProxyBypassList' argument to the installation script if env.variable 'no_proxy' is set`, async () => {
          process.env['no_proxy'] = 'first.url,second.url';
          const inputVersion = '10.0.101';
          const inputQuality = '';
          const stdout = `Fictitious dotnet version ${inputVersion} is installed`;

          getExecOutputSpy.mockImplementation(() => {
            return Promise.resolve({
              exitCode: 0,
              stdout: `${stdout}`,
              stderr: ''
            });
          });
          maxSatisfyingSpy.mockImplementation(() => inputVersion);

          const dotnetInstaller = new installer.DotnetCoreInstaller(
            inputVersion,
            inputQuality
          );

          await dotnetInstaller.installDotnet();

          /**
           * First time script would be called to
           * install runtime, here we checking only the
           * second one that installs actual SDK. i.e. 1
           */
          const callIndex = 1;

          const scriptArguments = (
            getExecOutputSpy.mock.calls[callIndex][1] as string[]
          ).join(' ');

          expect(scriptArguments).toContain(
            `-ProxyBypassList ${process.env['no_proxy']}`
          );
        });
      }

      it(`should supply 'architecture' argument to the installation script when architecture is provided`, async () => {
        const inputVersion = '10.0.101';
        const inputQuality = '';
        const inputArchitecture = 'x64';
        const stdout = `Fictitious dotnet version ${inputVersion} is installed`;

        getExecOutputSpy.mockImplementation(() => {
          return Promise.resolve({
            exitCode: 0,
            stdout: `${stdout}`,
            stderr: ''
          });
        });
        maxSatisfyingSpy.mockImplementation(() => inputVersion);

        const dotnetInstaller = new installer.DotnetCoreInstaller(
          inputVersion,
          inputQuality,
          inputArchitecture
        );

        await dotnetInstaller.installDotnet();

        const callIndex = 1;
        const scriptArguments = (
          getExecOutputSpy.mock.calls[callIndex][1] as string[]
        ).join(' ');
        const expectedArgument = IS_WINDOWS
          ? `-Architecture ${inputArchitecture}`
          : `--architecture ${inputArchitecture}`;

        expect(scriptArguments).toContain(expectedArgument);
      });

      it(`should NOT supply 'architecture' argument when architecture is not provided`, async () => {
        const inputVersion = '10.0.101';
        const inputQuality = '';
        const stdout = `Fictitious dotnet version ${inputVersion} is installed`;

        getExecOutputSpy.mockImplementation(() => {
          return Promise.resolve({
            exitCode: 0,
            stdout: `${stdout}`,
            stderr: ''
          });
        });
        maxSatisfyingSpy.mockImplementation(() => inputVersion);

        const dotnetInstaller = new installer.DotnetCoreInstaller(
          inputVersion,
          inputQuality
        );

        await dotnetInstaller.installDotnet();

        const callIndex = 1;
        const scriptArguments = (
          getExecOutputSpy.mock.calls[callIndex][1] as string[]
        ).join(' ');

        expect(scriptArguments).not.toContain('--architecture');
        expect(scriptArguments).not.toContain('-Architecture');
      });

      it(`should supply 'install-dir' with arch subdirectory for cross-arch install`, async () => {
        const inputVersion = '10.0.101';
        const inputQuality = '';
        const inputArchitecture = 'x64';
        const stdout = `Fictitious dotnet version ${inputVersion} is installed`;

        getExecOutputSpy.mockImplementation(() => {
          return Promise.resolve({
            exitCode: 0,
            stdout: `${stdout}`,
            stderr: ''
          });
        });
        maxSatisfyingSpy.mockImplementation(() => inputVersion);

        // Mock os.arch() to return a different arch to simulate cross-arch
        const archSpy = jest.spyOn(os, 'arch').mockReturnValue('arm64');

        const dotnetInstaller = new installer.DotnetCoreInstaller(
          inputVersion,
          inputQuality,
          inputArchitecture
        );

        await dotnetInstaller.installDotnet();

        const callIndex = 1;
        const scriptArguments = (
          getExecOutputSpy.mock.calls[callIndex][1] as string[]
        ).join(' ');

        const expectedInstallDirFlag = IS_WINDOWS
          ? '-InstallDir'
          : '--install-dir';

        expect(scriptArguments).toContain(expectedInstallDirFlag);
        expect(scriptArguments).toContain(inputArchitecture);

        archSpy.mockRestore();
      });

      it(`should NOT supply 'install-dir' when architecture matches runner's native arch`, async () => {
        const inputVersion = '10.0.101';
        const inputQuality = '';
        const nativeArch = os.arch().toLowerCase();
        const stdout = `Fictitious dotnet version ${inputVersion} is installed`;

        getExecOutputSpy.mockImplementation(() => {
          return Promise.resolve({
            exitCode: 0,
            stdout: `${stdout}`,
            stderr: ''
          });
        });
        maxSatisfyingSpy.mockImplementation(() => inputVersion);

        const dotnetInstaller = new installer.DotnetCoreInstaller(
          inputVersion,
          inputQuality,
          nativeArch
        );

        await dotnetInstaller.installDotnet();

        const callIndex = 1;
        const scriptArguments = (
          getExecOutputSpy.mock.calls[callIndex][1] as string[]
        ).join(' ');

        expect(scriptArguments).not.toContain('--install-dir');
        expect(scriptArguments).not.toContain('-InstallDir');
      });
    });

    describe('addToPath() tests', () => {
      it(`should export DOTNET_ROOT env.var with value from DOTNET_INSTALL_DIR env.var`, async () => {
        process.env['DOTNET_INSTALL_DIR'] = 'fictitious/dotnet/install/dir';
        installer.DotnetInstallDir.addToPath();
        const dotnet_root = process.env['DOTNET_ROOT'];
        expect(dotnet_root).toBe(process.env['DOTNET_INSTALL_DIR']);
      });

      it(`should export value from DOTNET_INSTALL_DIR env.var to the PATH`, async () => {
        process.env['DOTNET_INSTALL_DIR'] = 'fictitious/dotnet/install/dir';
        installer.DotnetInstallDir.addToPath();
        const path = process.env['PATH'];
        expect(path).toContain(process.env['DOTNET_INSTALL_DIR']);
      });
    });

    describe('install directory fallback tests', () => {
      // Mock factories re-run on resetModules, so the installer sees new
      // instances; configure those, not the ones captured at file load.
      const importInstallerFor = async (
        platform: 'windows' | 'linux' | 'mac',
        isWritable: (dir: string) => boolean
      ) => {
        platformOverride = platform;
        jest.resetModules();

        const freshFs = await import('fs');
        (freshFs.lstatSync as jest.Mock).mockReturnValue({} as Stats);
        (freshFs.mkdtempSync as jest.Mock).mockImplementation(
          (...args: unknown[]) => {
            const prefix = String(args[0]);
            if (!isWritable(path.dirname(prefix))) {
              throw Object.assign(new Error('permission denied'), {
                code: 'EACCES'
              });
            }
            return `${prefix}abc123`;
          }
        );
        (freshFs.rmSync as jest.Mock).mockImplementation(() => {});

        const freshCore = await import('@actions/core');
        const {DotnetInstallDir} = await import('../src/installer.js');

        return {DotnetInstallDir, core: freshCore, fs: freshFs};
      };

      afterEach(() => {
        platformOverride = undefined;
      });

      it(`should use the default location when it is writable`, async () => {
        delete process.env['DOTNET_INSTALL_DIR'];
        const {DotnetInstallDir} = await importInstallerFor(
          'linux',
          () => true
        );

        expect(DotnetInstallDir.dirPath).toBe('/usr/share/dotnet');
      });

      it(`should fall back to the home directory when the default location is not writable`, async () => {
        delete process.env['DOTNET_INSTALL_DIR'];
        const fallbackPath = path.join(os.homedir(), '.dotnet');
        const {DotnetInstallDir, core: freshCore} = await importInstallerFor(
          'linux',
          dir => dir === fallbackPath
        );

        expect(DotnetInstallDir.dirPath).toBe(fallbackPath);
        expect(freshCore.warning).toHaveBeenCalled();
      });

      it(`should reject a dangling symlink instead of probing its writable parent`, async () => {
        delete process.env['DOTNET_INSTALL_DIR'];
        // Resolved, because that is the form the probe receives on every platform.
        const linkPath = path.resolve('/usr/share/dotnet');
        const {DotnetInstallDir, fs: freshFs} = await importInstallerFor(
          'linux',
          () => true
        );
        // A dangling link exists for lstat, but nothing can be created under it.
        (freshFs.mkdtempSync as jest.Mock).mockImplementation(
          (...args: unknown[]) => {
            if (path.dirname(String(args[0])) === linkPath) {
              throw Object.assign(new Error('no such file or directory'), {
                code: 'ENOENT'
              });
            }
            return `${args[0]}abc123`;
          }
        );

        expect(DotnetInstallDir.dirPath).toBe(
          path.join(os.homedir(), '.dotnet')
        );
        const probedIn = (freshFs.mkdtempSync as jest.Mock).mock.calls.map(
          call => path.dirname(String(call[0]))
        );
        expect(probedIn).toContain(linkPath);
        expect(probedIn).not.toContain(path.dirname(linkPath));
      });

      it(`should probe the nearest existing parent when the directory is missing`, async () => {
        delete process.env['DOTNET_INSTALL_DIR'];
        const systemPath = path.resolve('/usr/share/dotnet');
        const parentPath = path.dirname(systemPath);
        const {DotnetInstallDir, fs: freshFs} = await importInstallerFor(
          'linux',
          () => true
        );
        // Only the parent exists, so the walk has to climb before probing.
        (freshFs.lstatSync as jest.Mock).mockImplementation(
          (...args: unknown[]) =>
            path.resolve(String(args[0])) === parentPath
              ? ({} as Stats)
              : undefined
        );

        expect(DotnetInstallDir.dirPath).toBe('/usr/share/dotnet');
        const probedIn = (freshFs.mkdtempSync as jest.Mock).mock.calls.map(
          call => path.dirname(String(call[0]))
        );
        expect(probedIn).toContain(parentPath);
        expect(probedIn).not.toContain(systemPath);
      });

      it(`should give up at the filesystem root when no ancestor exists`, async () => {
        delete process.env['DOTNET_INSTALL_DIR'];
        const systemPath = path.resolve('/usr/share/dotnet');
        const homePath = path.join(os.homedir(), '.dotnet');
        const {DotnetInstallDir, fs: freshFs} = await importInstallerFor(
          'linux',
          () => true
        );
        // Nothing on the system path exists, all the way up to the root.
        (freshFs.lstatSync as jest.Mock).mockImplementation(
          (...args: unknown[]) =>
            systemPath.startsWith(path.resolve(String(args[0])))
              ? undefined
              : ({} as Stats)
        );

        expect(DotnetInstallDir.dirPath).toBe(homePath);
        const probedIn = (freshFs.mkdtempSync as jest.Mock).mock.calls.map(
          call => path.dirname(String(call[0]))
        );
        // The walk hit the root and returned without ever probing.
        expect(probedIn).toEqual([homePath]);
      });

      it(`should keep the default location and warn when neither is writable`, async () => {
        delete process.env['DOTNET_INSTALL_DIR'];
        const {DotnetInstallDir, core: freshCore} = await importInstallerFor(
          'linux',
          () => false
        );

        expect(DotnetInstallDir.dirPath).toBe('/usr/share/dotnet');
        expect((freshCore.warning as jest.Mock).mock.calls[0][0]).toContain(
          'the installation is likely to fail'
        );
      });

      it(`should prefer DOTNET_INSTALL_DIR env.var without probing`, async () => {
        process.env['DOTNET_INSTALL_DIR'] = path.join(path.sep, 'custom');
        const {DotnetInstallDir, fs: freshFs} = await importInstallerFor(
          'linux',
          () => false
        );

        expect(DotnetInstallDir.dirPath).toBe(path.join(path.sep, 'custom'));
        expect(freshFs.mkdtempSync as jest.Mock).not.toHaveBeenCalled();
      });

      it(`should not touch the filesystem until the directory is needed`, async () => {
        delete process.env['DOTNET_INSTALL_DIR'];
        const {fs: freshFs} = await importInstallerFor('linux', () => true);

        expect(freshFs.mkdtempSync as jest.Mock).not.toHaveBeenCalled();
      });
    });
  });

  describe('normalizeArch() tests', () => {
    it(`should normalize 'amd64' to 'x64'`, () => {
      expect(installer.normalizeArch('amd64')).toBe('x64');
    });

    it(`should normalize 'AMD64' to 'x64' (case-insensitive)`, () => {
      expect(installer.normalizeArch('AMD64')).toBe('x64');
    });

    it(`should pass through 'x64' unchanged`, () => {
      expect(installer.normalizeArch('x64')).toBe('x64');
    });

    it(`should pass through 'arm64' unchanged`, () => {
      expect(installer.normalizeArch('arm64')).toBe('arm64');
    });

    it(`should lowercase 'ARM64'`, () => {
      expect(installer.normalizeArch('ARM64')).toBe('arm64');
    });

    it(`should pass through 'x86' unchanged`, () => {
      expect(installer.normalizeArch('x86')).toBe('x86');
    });
  });

  describe('DotnetVersionResolver tests', () => {
    describe('createDotnetVersion() tests', () => {
      each([
        '10.0',
        '10.x',
        '10.0.x',
        '10.0.*',
        '10.0.X',
        '10.0.0',
        '10.0.0-preview7',
        '10.0.1xx'
      ]).test(
        'if valid version is supplied (%s), it should return version object with some value',
        async version => {
          const dotnetVersionResolver = new installer.DotnetVersionResolver(
            version
          );
          const versionObject =
            await dotnetVersionResolver.createDotnetVersion();

          expect(!!versionObject.value).toBe(true);
        }
      );

      each([
        '.',
        '..',
        ' . ',
        '. ',
        ' .',
        ' . . ',
        ' .. ',
        ' .  ',
        '-1.-1',
        '-1',
        '-1.-1.-1',
        '..3',
        '1..3',
        '1..',
        '.2.3',
        '.2.x',
        '*.',
        '1.2.',
        '1.2.-abc',
        'a.b',
        'a.b.c',
        'a.b.c-preview',
        ' 0 . 1 . 2 ',
        'invalid'
      ]).test(
        'if invalid version is supplied (%s), it should throw',
        async version => {
          const dotnetVersionResolver = new installer.DotnetVersionResolver(
            version
          );

          await expect(
            async () => await dotnetVersionResolver.createDotnetVersion()
          ).rejects.toThrow();
        }
      );

      each(['10', '10.0', '10.0.x', '10.0.*', '10.0.X', '10.0.1xx']).test(
        "if version that can be resolved to 'channel' option is supplied (%s), it should set type to 'channel' in version object",
        async version => {
          const dotnetVersionResolver = new installer.DotnetVersionResolver(
            version
          );
          const versionObject =
            await dotnetVersionResolver.createDotnetVersion();

          expect(versionObject.type.toLowerCase().includes('channel')).toBe(
            true
          );
        }
      );

      each(['10.0', '10.0.x', '10.0.*', '10.0.X', '10.0.1xx']).test(
        "if version that can be resolved to 'channel' option is supplied and its major tag is >= 6 (%s), it should set type to 'channel' and qualityFlag to 'true' in version object",
        async version => {
          const dotnetVersionResolver = new installer.DotnetVersionResolver(
            version
          );
          const versionObject =
            await dotnetVersionResolver.createDotnetVersion();

          expect(versionObject.type.toLowerCase().includes('channel')).toBe(
            true
          );
          expect(versionObject.qualityFlag).toBe(true);
        }
      );

      each(['10.0.0', '10.0.0-preview7']).test(
        "if version that can be resolved to 'version' option is supplied (%s), it should set quality flag to 'false' and type to 'version' in version object",
        async version => {
          const dotnetVersionResolver = new installer.DotnetVersionResolver(
            version
          );
          const versionObject =
            await dotnetVersionResolver.createDotnetVersion();

          expect(versionObject.type.toLowerCase().includes('version')).toBe(
            true
          );
          expect(versionObject.qualityFlag).toBe(false);
        }
      );

      each(['10.0.0', '10.0']).test(
        'it should create proper line arguments for powershell/bash installation scripts',
        async version => {
          const dotnetVersionResolver = new installer.DotnetVersionResolver(
            version
          );
          const versionObject =
            await dotnetVersionResolver.createDotnetVersion();
          const windowsRegEx = new RegExp(/^-(Version|Channel)/);
          const nonWindowsRegEx = new RegExp(/^--(version|channel)/);

          if (IS_WINDOWS) {
            expect(windowsRegEx.test(versionObject.type)).toBe(true);
            expect(nonWindowsRegEx.test(versionObject.type)).toBe(false);
          } else {
            expect(nonWindowsRegEx.test(versionObject.type)).toBe(true);
            expect(windowsRegEx.test(versionObject.type)).toBe(false);
          }
        }
      );

      it(`should throw if dotnet-version is supplied in A.B.Cxx syntax with major tag lower that 5`, async () => {
        const version = '3.0.1xx';
        const dotnetVersionResolver = new installer.DotnetVersionResolver(
          version
        );
        await expect(
          async () => await dotnetVersionResolver.createDotnetVersion()
        ).rejects.toThrow(
          `'dotnet-version' was supplied in invalid format: ${version}! The A.B.Cxx syntax is available since the .NET 5.0 release.`
        );
      });
    });
  });
});
