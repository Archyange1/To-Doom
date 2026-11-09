const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const WORK_DIR = path.join(os.tmpdir(), 'todoom-apk-build');
const ANDROID_SRC = path.join(ROOT, 'android-build');
const BUILD_OUT = path.join(WORK_DIR, 'out');
const CLASSES_DIR = path.join(BUILD_OUT, 'classes');
const ASSETS_DIR = path.join(WORK_DIR, 'assets');
const RES_DIR = path.join(WORK_DIR, 'res', 'drawable');

const SDK = 'C:\\Users\\foxxx\\AppData\\Local\\Android\\Sdk';
const BUILD_TOOLS = path.join(SDK, 'build-tools', '36.0.0');
const ANDROID_JAR = path.join(SDK, 'platforms', 'android-35', 'android.jar');
const JAVA_HOME = 'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.12.101-hotspot';
const JAVA_EXE = path.join(JAVA_HOME, 'bin', 'java.exe');
const JAVAC_EXE = path.join(JAVA_HOME, 'bin', 'javac.exe');
const JAR_EXE = path.join(JAVA_HOME, 'bin', 'jar.exe');
const AAPT2_EXE = path.join(BUILD_TOOLS, 'aapt2.exe');
const ZIPALIGN_EXE = path.join(BUILD_TOOLS, 'zipalign.exe');
const D8_JAR = path.join(BUILD_TOOLS, 'lib', 'd8.jar');
const APKSIGNER_JAR = path.join(BUILD_TOOLS, 'lib', 'apksigner.jar');
const KEYSTORE = 'C:\\Users\\foxxx\\.android\\debug.keystore';

// Clean and prepare ASCII work directory
if (fs.existsSync(WORK_DIR)) fs.rmSync(WORK_DIR, { recursive: true, force: true });
fs.mkdirSync(CLASSES_DIR, { recursive: true });
fs.mkdirSync(ASSETS_DIR, { recursive: true });
fs.mkdirSync(RES_DIR, { recursive: true });

// Copy AndroidManifest, resources, and Java source to ASCII workdir
fs.copyFileSync(
  path.join(ANDROID_SRC, 'AndroidManifest.xml'),
  path.join(WORK_DIR, 'AndroidManifest.xml')
);
fs.copyFileSync(
  path.join(ANDROID_SRC, 'res', 'drawable', 'ic_launcher.xml'),
  path.join(RES_DIR, 'ic_launcher.xml')
);
const javaTargetDir = path.join(WORK_DIR, 'src', 'com', 'todoom', 'app');
fs.mkdirSync(javaTargetDir, { recursive: true });
fs.copyFileSync(
  path.join(ANDROID_SRC, 'src', 'com', 'todoom', 'app', 'MainActivity.java'),
  path.join(javaTargetDir, 'MainActivity.java')
);

// Copy public web files into Android assets
const publicDir = path.join(ROOT, 'public');
for (const file of fs.readdirSync(publicDir)) {
  fs.copyFileSync(path.join(publicDir, file), path.join(ASSETS_DIR, file));
}

console.log('1. Компіляція ресурсів (aapt2 compile)...');
const compiledResZip = path.join(BUILD_OUT, 'res.zip');
execFileSync(AAPT2_EXE, [
  'compile',
  '--dir', path.join(WORK_DIR, 'res'),
  '-o', compiledResZip
], { stdio: 'inherit' });

console.log('2. Лінкування ресурсів та маніфесту (aapt2 link)...');
const unalignedApk = path.join(BUILD_OUT, 'unaligned.apk');
const rJavaDir = path.join(BUILD_OUT, 'gen');
fs.mkdirSync(rJavaDir, { recursive: true });

execFileSync(AAPT2_EXE, [
  'link',
  '-I', ANDROID_JAR,
  '--manifest', path.join(WORK_DIR, 'AndroidManifest.xml'),
  '-A', ASSETS_DIR,
  '-o', unalignedApk,
  '--java', rJavaDir,
  compiledResZip
], { stdio: 'inherit' });

console.log('3. Компіляція Java-коду (javac)...');
const mainJava = path.join(javaTargetDir, 'MainActivity.java');
const rJava = path.join(rJavaDir, 'com', 'todoom', 'app', 'R.java');
execFileSync(JAVAC_EXE, [
  '--release', '11',
  '-cp', ANDROID_JAR,
  '-d', CLASSES_DIR,
  mainJava,
  rJava
], { stdio: 'inherit' });

console.log('4. Конвертація у Dalvik bytecode classes.dex (D8)...');
const classFiles = [];
function collectClassFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectClassFiles(full);
    else if (entry.name.endsWith('.class')) classFiles.push(full);
  }
}
collectClassFiles(CLASSES_DIR);

execFileSync(JAVA_EXE, [
  '-cp', D8_JAR,
  'com.android.tools.r8.D8',
  '--lib', ANDROID_JAR,
  '--min-api', '24',
  '--output', BUILD_OUT,
  ...classFiles
], { stdio: 'inherit' });

console.log('5. Додавання classes.dex до APK...');
execFileSync(JAR_EXE, [
  'uf', unalignedApk,
  '-C', BUILD_OUT, 'classes.dex'
], { stdio: 'inherit' });

console.log('6. Вирівнювання APK (zipalign)...');
const alignedApk = path.join(BUILD_OUT, 'aligned.apk');
execFileSync(ZIPALIGN_EXE, [
  '-f', '-p', '4',
  unalignedApk,
  alignedApk
], { stdio: 'inherit' });

console.log('7. Підпис APK (apksigner)...');
const signedTempApk = path.join(BUILD_OUT, 'To-Doom-signed.apk');
execFileSync(JAVA_EXE, [
  '-jar', APKSIGNER_JAR,
  'sign',
  '--ks', KEYSTORE,
  '--ks-key-alias', 'androiddebugkey',
  '--ks-pass', 'pass:android',
  '--key-pass', 'pass:android',
  '--out', signedTempApk,
  alignedApk
], { stdio: 'inherit' });

const finalApkProject = path.join(ROOT, 'To Doom.apk');
const finalApkDesktop = 'C:\\Users\\foxxx\\Desktop\\To Doom.apk';

fs.copyFileSync(signedTempApk, finalApkProject);
fs.copyFileSync(signedTempApk, finalApkDesktop);

console.log('ГОТОВО! APK успішно зібрано та підписано:');
console.log(' -> ' + finalApkProject);
console.log(' -> ' + finalApkDesktop);
