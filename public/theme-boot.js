(function () {
  var k = "privatebit.theme";
  var t;
  try {
    t = localStorage.getItem(k);
  } catch (e) {}
  if (t !== "light" && t !== "system" && t !== "dark") t = "dark";
  document.documentElement.setAttribute("data-theme", t);
  var dark = t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.style.background = dark ? "#110c26" : "#f4f1ea";
  document.documentElement.style.color = dark ? "#f4f1ea" : "#2a1848";
})();
