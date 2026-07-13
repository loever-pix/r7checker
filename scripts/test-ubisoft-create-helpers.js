import assert from 'assert';

const normalize = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const findByText = (nodes, text) => nodes
  .find(node => {
    const label = normalize(node.innerText || node.textContent || '');
    const wanted = normalize(text);
    return label === wanted || label.includes(wanted);
  });

assert(findByText([{ textContent: 'CREATE AN ACCOUNT' }], 'CREATE AN ACCOUNT'));
assert(findByText([{ innerText: ' CONTINUE ' }], 'CONTINUE'));
assert(findByText([{ innerText: 'LOGIN   CREATE AN ACCOUNT' }], 'CREATE AN ACCOUNT'));
assert(findByText([{ innerText: 'CREATE ACCOUNT' }], 'CREATE ACCOUNT'));

console.log('ubisoft create helper tests passed');
