/**
 * CI Syntax Validation Script (executed in GitHub Actions runner)
 * Validates syntax of all .js and .gs files in src/ using Node's built-in vm module.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function findFiles(dir, extensions) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(findFiles(fullPath, extensions));
    } else {
      const ext = path.extname(file);
      if (extensions.includes(ext)) {
        results.push(fullPath);
      }
    }
  });
  return results;
}

const files = findFiles('src', ['.js', '.gs']);
if (files.length === 0) {
  console.log('✓ No JavaScript/Apps Script files found in src/ to validate yet.');
  process.exit(0);
}

let hasErrors = false;
files.forEach(file => {
  try {
    const code = fs.readFileSync(file, 'utf8');
    new vm.Script(code, { filename: file });
    console.log(`✓ Syntax OK: ${file}`);
  } catch (err) {
    console.error(`✗ Syntax error in ${file}:`, err.message);
    hasErrors = true;
  }
});

if (hasErrors) {
  process.exit(1);
}
console.log(`✓ All ${files.length} script files passed syntax validation.`);
