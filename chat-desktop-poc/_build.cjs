// 这台机器上的 node 是 Electron 运行时，它的 asar 层会拦截写 app.asar，必须禁用
process.noAsar = true

const path = require('node:path')
const { build } = require('electron-builder')

// 用脚本自身所在目录，避免写死绝对路径导致换机器 / CI 上找不到项目
const projectDir = __dirname

build({
  projectDir,
  config: {
    appId: 'com.chatdesktop.app',
    productName: 'ChatDesktop',
    directories: { output: 'release' },
    files: [
      'main.cjs',
      'preload.cjs',
      'settings-preload.cjs',
      'settings.html',
      'dist/**',
      'build/**',
      'package.json',
    ],
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
      icon: 'build/icon.ico',
      artifactName: 'ChatDesktop-${version}-Setup.${ext}',
      // 无管理员权限时 winCodeSign 解压失败；图标改由 afterPack 里的 rcedit 补
      signAndEditExecutable: false,
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'ChatDesktop',
      deleteAppDataOnUninstall: false,
    },
    afterPack: async (context) => {
      const { rcedit } = await import('rcedit')
      const exePath = path.join(context.appOutDir, 'ChatDesktop.exe')
      await rcedit(exePath, { icon: path.join(projectDir, 'build', 'icon.ico') })
      console.log('[afterPack] 已写入 exe 图标')
    },
  },
})
  .then(() => {
    console.log('BUILD DONE')
    process.exit(0)
  })
  .catch((e) => {
    console.error('BUILD FAILED:', e.stack || e)
    process.exit(1)
  })
