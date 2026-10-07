// /weld/ was the front page's address before it moved to /. Links to it, and to /lite/, keep working: they land on /
// with their query and fragment (#farm, #sp=…) kept.
window.location.replace('/' + window.location.search + window.location.hash);
