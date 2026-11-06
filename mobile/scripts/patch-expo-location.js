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

if (fs.existsSync(destDir)) {
  const files = ['LocationHelpers.kt', 'LocationModule.kt'];
  for (const file of files) {
    const srcFile = path.join(srcDir, file);
    const destFile = path.join(destDir, file);
    if (fs.existsSync(srcFile)) {
      fs.copyFileSync(srcFile, destFile);
      console.log(`[patch] Applied native patch to ${file}`);
    }
  }
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
