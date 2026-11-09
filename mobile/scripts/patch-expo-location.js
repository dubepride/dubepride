const fs = require('fs');
const path = require('path');

// 1. Patch expo-location for non-GMS fallback (Huawei support)
const srcDir = path.join(__dirname, '..', 'android-patches');
const destDir = path.join(
  __dirname,
  '..',
  'node_modules',
  'expo-location',
  'android',
  'src',
  'main',
  'java',
  'expo',
  'modules',
  'location'
);

const REQUIRED_MARKER = 'biobridge-native-v2';

if (fs.existsSync(destDir)) {
  const patches = [
    { src: 'LocationHelpers.kt', dest: 'LocationHelpers.kt' },
    { src: 'LocationModule.kt', dest: 'LocationModule.kt' },
    { src: 'LocationTaskConsumer.kt', dest: path.join('taskConsumers', 'LocationTaskConsumer.kt') },
    { src: 'LocationTaskService.kt', dest: path.join('services', 'LocationTaskService.kt') },
  ];
  const failures = [];
  for (const patch of patches) {
    const srcFile = path.join(srcDir, patch.src);
    const destFile = path.join(destDir, patch.dest);
    if (!fs.existsSync(srcFile)) {
      failures.push(`missing source patch: ${srcFile}`);
      continue;
    }
    if (!fs.existsSync(path.dirname(destFile))) {
      failures.push(`missing expo-location destination: ${path.dirname(destFile)}`);
      continue;
    }
    fs.copyFileSync(srcFile, destFile);
    const copied = fs.readFileSync(destFile, 'utf8');
    if (!copied.includes(REQUIRED_MARKER)) {
      failures.push(`${patch.dest} does not contain the ${REQUIRED_MARKER} marker`);
      continue;
    }
    console.log(`[patch] Applied native patch to ${patch.dest}`);
  }

  // Expo SDK 54+ ships Expo modules as prebuilt AARs by default. Patching the
  // Kotlin sources alone would be silently ignored because Gradle would keep
  // resolving the stock AAR. Removing the `publication` entry forces Gradle to
  // compile expo-location from node_modules, which is where the patch lives.
  const moduleConfigPath = path.join(
    __dirname,
    '..',
    'node_modules',
    'expo-location',
    'expo-module.config.json'
  );
  try {
    const raw = fs.readFileSync(moduleConfigPath, 'utf8').replace(/^\uFEFF/, '');
    const moduleConfig = JSON.parse(raw);
    if (moduleConfig.android && moduleConfig.android.publication) {
      delete moduleConfig.android.publication;
      fs.writeFileSync(moduleConfigPath, `${JSON.stringify(moduleConfig, null, 2)}\n`, 'utf8');
      console.log('[patch] Forced expo-location to build from source (removed prebuilt AAR)');
    }

    const verifyRaw = fs.readFileSync(moduleConfigPath, 'utf8').replace(/^\uFEFF/, '');
    const verified = JSON.parse(verifyRaw);
    if (verified.android && verified.android.publication) {
      failures.push(
        'expo-location still resolves a prebuilt AAR; the native patch would not be compiled into the APK'
      );
    }
  } catch (err) {
    failures.push(
      `could not force expo-location to build from source: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  if (failures.length > 0) {
    console.error('\n[FATAL] The Huawei / non-GMS location patch is not intact:');
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    console.error(
      '\nRefusing to continue: an APK built from this tree would not contain the native location fallback.\n'
    );
    process.exit(1);
  }
  console.log(
    `[patch] Verified ${REQUIRED_MARKER} in all ${patches.length} native location files`
  );
} else {
  console.error(`\n[FATAL] expo-location is missing at ${destDir}`);
  console.error('Install dependencies before building so the native location patch can be applied.\n');
  process.exit(1);
}

// 2. Patch react-native-safe-area-context CMakeLists to avoid Windows MAX_PATH (>260 chars) error
const safeAreaJniDir = path.join(
  __dirname,
  '..',
  'node_modules',
  'react-native-safe-area-context',
  'android',
  'src',
  'main',
  'jni'
);
const safeAreaCommonDir = path.join(
  __dirname,
  '..',
  'node_modules',
  'react-native-safe-area-context',
  'common',
  'cpp',
  'react',
  'renderer',
  'components',
  'safeareacontext'
);

if (fs.existsSync(safeAreaJniDir)) {
  if (fs.existsSync(safeAreaCommonDir)) {
    const commonFiles = fs.readdirSync(safeAreaCommonDir);
    for (const f of commonFiles) {
      if (f.endsWith('.cpp') || f.endsWith('.h')) {
        fs.copyFileSync(path.join(safeAreaCommonDir, f), path.join(safeAreaJniDir, f));
      }
    }
  }

  // Copy generated cpp files to avoid long path in CMake
  const gen1 = path.join(safeAreaJniDir, '..', '..', '..', 'build', 'generated', 'source', 'codegen', 'jni');
  const gen2 = path.join(gen1, 'react', 'renderer', 'components', 'safeareacontext');
  if (fs.existsSync(gen1)) {
    for (const f of fs.readdirSync(gen1)) {
      if (f.endsWith('.cpp')) fs.copyFileSync(path.join(gen1, f), path.join(safeAreaJniDir, f));
    }
  }
  if (fs.existsSync(gen2)) {
    for (const f of fs.readdirSync(gen2)) {
      if (f.endsWith('.cpp')) fs.copyFileSync(path.join(gen2, f), path.join(safeAreaJniDir, f));
    }
  }

  const headerPath = path.join(safeAreaJniDir, 'safeareacontext.h');
  if (fs.existsSync(headerPath)) {
    let headerContent = fs.readFileSync(headerPath, 'utf8');
    if (!headerContent.includes('NativeSafeAreaContextSpecJSI')) {
      headerContent = headerContent.replace(
        'namespace react {',
        'namespace react {\n\nclass JSI_EXPORT NativeSafeAreaContextSpecJSI : public JavaTurboModule {\npublic:\n  NativeSafeAreaContextSpecJSI(const JavaTurboModule::InitParams &params);\n};'
      );
      fs.writeFileSync(headerPath, headerContent, 'utf8');
    }
  }

  const cmakePath = path.join(safeAreaJniDir, 'CMakeLists.txt');
  if (fs.existsSync(cmakePath)) {
    let cmakeContent = fs.readFileSync(cmakePath, 'utf8');
    if (!cmakeContent.includes('file(GLOB LIB_SRCS CONFIGURE_DEPENDS *.cpp)')) {
      cmakeContent = cmakeContent.replace(
        /file\(GLOB LIB_CUSTOM_SRCS[^\)]+\)[\s\S]*?add_library\([\s\S]*?\$\{LIB_CODEGEN_SRCS\}[\s\S]*?\)/,
        'file(GLOB LIB_SRCS CONFIGURE_DEPENDS *.cpp)\n\nadd_library(\n  ${LIB_TARGET_NAME}\n  SHARED\n  ${LIB_SRCS}\n)'
      );
      fs.writeFileSync(cmakePath, cmakeContent, 'utf8');
      console.log('[patch] Shortened safe-area-context CMake source path for Windows MAX_PATH');
    }
  }
}
