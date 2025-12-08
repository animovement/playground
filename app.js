import { WebR } from 'https://webr.r-wasm.org/latest/webr.mjs';

// ===== State =====

let webR = null;
let editor = null;
let consoleInput = null;
let isRunning = false;
let commandHistory = [];
let historyIndex = -1;
let plotImages = [];
let currentPlotIndex = 0;

// ===== DOM Ready Check =====

function getElement(id) {
  const el = document.getElementById(id);
  if (!el) console.error(`Element not found: ${id}`);
  return el;
}

// ===== Editor Setup =====

function rAutoIndent(cm) {
  const cursor = cm.getCursor();
  const line = cursor.line;
  const prevLine = line > 0 ? cm.getLine(line - 1) : '';
  const prevIndent = prevLine.match(/^\s*/)[0];
  const trimmedPrev = prevLine.trimEnd();
  
  const shouldIndent = /(\|>|%>%|\+|\{|\(|\[|,)$/.test(trimmedPrev);
  
  let newIndent = prevIndent;
  if (shouldIndent) {
    newIndent = prevIndent + '  ';
  }
  
  return newIndent;
}

function initEditor(initialCode) {
  const editorTextarea = getElement('editor');
  if (!editorTextarea) return;
  
  editor = CodeMirror.fromTextArea(editorTextarea, {
    mode: 'r',
    theme: 'default',
    lineNumbers: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    styleActiveLine: true,
    indentUnit: 2,
    tabSize: 2,
    indentWithTabs: false,
    extraKeys: {
      'Cmd-Enter': runFromEditor,
      'Ctrl-Enter': runFromEditor,
      'Shift-Cmd-M': (cm) => cm.replaceSelection(' |> '),
      'Shift-Ctrl-M': (cm) => cm.replaceSelection(' |> '),
      'Alt--': (cm) => cm.replaceSelection(' <- '),
      'Tab': (cm) => {
        if (cm.somethingSelected()) {
          cm.indentSelection('add');
        } else {
          cm.replaceSelection('  ', 'end');
        }
      },
      'Enter': (cm) => {
        const indent = rAutoIndent(cm);
        cm.replaceSelection('\n' + indent);
      }
    }
  });

  if (initialCode) {
    editor.setValue(initialCode);
  }
}

function initConsoleInput() {
  const consoleInputCm = getElement('consoleInputCm');
  if (!consoleInputCm) return;
  
  consoleInput = CodeMirror(consoleInputCm, {
    mode: 'r',
    theme: 'default',
    lineNumbers: false,
    matchBrackets: true,
    autoCloseBrackets: true,
    scrollbarStyle: 'null',
    viewportMargin: Infinity,
    extraKeys: {
      'Enter': handleConsoleEnter,
      'Up': handleConsoleUp,
      'Down': handleConsoleDown,
      'Shift-Cmd-M': (cm) => cm.replaceSelection(' |> '),
      'Shift-Ctrl-M': (cm) => cm.replaceSelection(' |> '),
      'Alt--': (cm) => cm.replaceSelection(' <- ')
    }
  });
}

function handleConsoleEnter() {
  const code = consoleInput.getValue().trim();
  if (code) {
    commandHistory.unshift(code);
    historyIndex = -1;
    consoleInput.setValue('');
    runCode(code);
  }
}

function handleConsoleUp() {
  if (historyIndex < commandHistory.length - 1) {
    historyIndex++;
    consoleInput.setValue(commandHistory[historyIndex]);
    consoleInput.setCursor(consoleInput.lineCount(), 0);
  }
}

function handleConsoleDown() {
  if (historyIndex > 0) {
    historyIndex--;
    consoleInput.setValue(commandHistory[historyIndex]);
    consoleInput.setCursor(consoleInput.lineCount(), 0);
  } else if (historyIndex === 0) {
    historyIndex = -1;
    consoleInput.setValue('');
  }
}

function runFromEditor() {
  if (!editor) return;
  
  const selection = editor.getSelection();
  let code;
  
  if (selection) {
    code = selection;
  } else {
    const cursor = editor.getCursor();
    code = editor.getLine(cursor.line);
    if (cursor.line < editor.lineCount() - 1) {
      editor.setCursor(cursor.line + 1, 0);
    }
  }
  
  if (code.trim()) {
    runCode(code.trim());
  }
}

// ===== Status =====

function setStatus(state, text) {
  const statusDot = getElement('statusDot');
  const statusText = getElement('statusText');
  if (statusDot) statusDot.className = 'status-dot ' + state;
  if (statusText) statusText.textContent = text;
}

// ===== Console =====

function appendConsole(text, type = 'stdout') {
  const consoleOutput = getElement('consoleOutput');
  if (!consoleOutput) return;
  
  const line = document.createElement('div');
  line.className = 'console-line ' + type;
  line.textContent = text;
  consoleOutput.appendChild(line);
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

function clearConsole() {
  const consoleOutput = getElement('consoleOutput');
  if (consoleOutput) consoleOutput.innerHTML = '';
}

// ===== Help =====

function clearHelp() {
  const helpContent = getElement('helpContent');
  const helpTopic = getElement('helpTopic');
  if (helpContent) helpContent.innerHTML = '<span class="help-empty">Run ?topic or help(topic) to view documentation</span>';
  if (helpTopic) helpTopic.textContent = '';
}

function displayHelp(topic, text) {
  const helpContent = getElement('helpContent');
  const helpTopic = getElement('helpTopic');
  
  if (helpTopic) helpTopic.textContent = topic;
  if (!helpContent) return;
  
  // Basic formatting for R help text
  let formatted = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^_([^_]+)_$/gm, '<div class="help-section">$1</div>')
    .replace(/^([A-Z][A-Za-z ]+):$/gm, '<div class="help-section">$1:</div>');
  
  helpContent.innerHTML = `<div class="help-content">${formatted}</div>`;
}

function isHelpRequest(code) {
  const helpMatch = code.match(/^\?(.+)$/) || code.match(/^help\(["']?([^"')]+)["']?\)$/);
  return helpMatch ? helpMatch[1].trim() : null;
}

async function getHelp(topic) {
  if (!webR) return;
  
  try {
    const result = await webR.evalRString(`
      tryCatch({
        h <- help("${topic}")
        if (length(h) > 0) {
          helpfile <- utils:::.getHelpFile(h)
          txt <- capture.output(tools::Rd2txt(helpfile, out = stdout(), package = attr(h, "package")))
          paste(txt, collapse = "\\n")
        } else {
          "No documentation found for '${topic}'"
        }
      }, error = function(e) {
        paste("Error:", e$message)
      })
    `);
    
    displayHelp(topic, result);
  } catch (error) {
    displayHelp(topic, `Error getting help: ${error.message}`);
  }
}

// ===== Plots =====

async function imageBitmapToDataUrl(bitmap) {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  return canvas.toDataURL('image/png');
}

function updatePlotDisplay() {
  const plotsEmpty = getElement('plotsEmpty');
  const plotContainer = getElement('plotContainer');
  const plotNav = getElement('plotNav');
  const plotImage = getElement('plotImage');
  const plotCounter = getElement('plotCounter');
  const plotPrev = getElement('plotPrev');
  const plotNext = getElement('plotNext');
  
  if (plotImages.length === 0) {
    if (plotsEmpty) plotsEmpty.style.display = '';
    if (plotContainer) plotContainer.style.display = 'none';
    if (plotNav) plotNav.style.display = 'none';
    return;
  }

  if (plotsEmpty) plotsEmpty.style.display = 'none';
  if (plotContainer) plotContainer.style.display = '';
  if (plotNav) plotNav.style.display = 'flex';

  if (plotImage) plotImage.src = plotImages[currentPlotIndex];
  if (plotCounter) plotCounter.textContent = `${currentPlotIndex + 1} / ${plotImages.length}`;

  if (plotPrev) plotPrev.disabled = currentPlotIndex === 0;
  if (plotNext) plotNext.disabled = currentPlotIndex === plotImages.length - 1;
}

async function addPlot(imageData) {
  let dataUrl;
  
  if (imageData instanceof ImageBitmap) {
    dataUrl = await imageBitmapToDataUrl(imageData);
  } else if (typeof imageData === 'string') {
    dataUrl = imageData;
  } else if (imageData instanceof Blob) {
    dataUrl = URL.createObjectURL(imageData);
  }

  plotImages.push(dataUrl);
  currentPlotIndex = plotImages.length - 1;
  updatePlotDisplay();
}

function clearPlots() {
  plotImages = [];
  currentPlotIndex = 0;
  updatePlotDisplay();
}

// ===== WebR =====

async function initWebR() {
  try {
    setStatus('loading', 'Initializing WebR...');
    
    webR = new WebR();
    await webR.init();

    setStatus('loading', 'Configuring repositories...');
    
    await webR.evalR(`
      options(
        repos = c(
          animovement = "https://animovement.r-universe.dev",
          CRAN = "https://repo.r-wasm.org"
        ),
        webr.show_menu = FALSE
      )
    `);

    setStatus('loading', 'Installing animovement...');
    clearConsole();
    appendConsole('Installing animovement package...', 'system');

    await webR.evalR(`
      webr::install("animovement", repos = c(
        "https://animovement.r-universe.dev",
        "https://repo.r-wasm.org"
      ))
    `);

    appendConsole('Loading animovement...', 'system');
    await webR.evalR('library(animovement)');

    appendConsole('Ready! animovement is loaded.', 'system');
    appendConsole('', 'system');

    setStatus('ready', 'Ready');
    
    const runBtn = getElement('runBtn');
    if (runBtn) runBtn.disabled = false;
    if (consoleInput) {
      consoleInput.setOption('readOnly', false);
      consoleInput.focus();
    }

  } catch (error) {
    setStatus('error', 'Initialization failed');
    appendConsole('Error: ' + error.message, 'stderr');
    console.error('WebR init error:', error);
  }
}

async function runCode(code) {
  if (isRunning || !webR || !code) return;

  // Check if this is a help request
  const helpTopicMatch = isHelpRequest(code);
  if (helpTopicMatch) {
    appendConsole('> ' + code, 'command');
    await getHelp(helpTopicMatch);
    return;
  }

  isRunning = true;
  const runBtn = getElement('runBtn');
  if (runBtn) runBtn.disabled = true;
  if (consoleInput) consoleInput.setOption('readOnly', true);
  setStatus('loading', 'Running...');

  const lines = code.split('\n');
  lines.forEach((line, i) => {
    appendConsole((i === 0 ? '> ' : '+ ') + line, 'command');
  });

  try {
    const shelter = await new webR.Shelter();
    
    try {
      const result = await shelter.captureR(code, {
        withAutoprint: true,
        captureStreams: true,
        captureConditions: true,
        captureGraphics: {
          width: 800,
          height: 600
        }
      });

      for (const out of result.output) {
        if (out.type === 'stdout' && out.data.trim()) {
          appendConsole(out.data, 'stdout');
        } else if (out.type === 'stderr' && out.data.trim()) {
          appendConsole(out.data, 'stderr');
        } else if (out.type === 'message') {
          appendConsole(out.data, 'stderr');
        }
      }

      if (result.images && result.images.length > 0) {
        for (const img of result.images) {
          await addPlot(img);
        }
      }

    } finally {
      await shelter.purge();
    }

  } catch (error) {
    appendConsole('Error: ' + error.message, 'stderr');
  }

  isRunning = false;
  if (runBtn) runBtn.disabled = false;
  if (consoleInput) consoleInput.setOption('readOnly', false);
  setStatus('ready', 'Ready');
}

// ===== Resize =====

function initResize() {
  const leftPane = getElement('leftPane');
  const rightPane = getElement('rightPane');
  const editorPanel = getElement('editorPanel');
  const consolePanel = getElement('consolePanel');
  const helpPanel = getElement('helpPanel');
  const plotsPanel = getElement('plotsPanel');
  const resizeH = getElement('resizeH');
  const resizeV = getElement('resizeV');
  const resizeVRight = getElement('resizeVRight');

  // Horizontal resize (left/right panes)
  if (resizeH && leftPane && rightPane) {
    resizeH.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startLeftWidth = leftPane.getBoundingClientRect().width;
      const startRightWidth = rightPane.getBoundingClientRect().width;
      
      document.body.classList.add('resizing');
      resizeH.classList.add('dragging');
      
      const onMouseMove = (e) => {
        const delta = e.clientX - startX;
        const totalWidth = startLeftWidth + startRightWidth;
        const newLeftWidth = Math.max(200, Math.min(totalWidth - 200, startLeftWidth + delta));
        const newRightWidth = totalWidth - newLeftWidth;
        
        leftPane.style.flex = `0 0 ${newLeftWidth}px`;
        rightPane.style.flex = `0 0 ${newRightWidth}px`;
      };
      
      const onMouseUp = () => {
        document.body.classList.remove('resizing');
        resizeH.classList.remove('dragging');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        if (editor) editor.refresh();
        if (consoleInput) consoleInput.refresh();
      };
      
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  // Vertical resize (editor/console)
  if (resizeV && editorPanel && consolePanel) {
    resizeV.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startEditorHeight = editorPanel.getBoundingClientRect().height;
      const startConsoleHeight = consolePanel.getBoundingClientRect().height;
      
      document.body.classList.add('resizing-v');
      resizeV.classList.add('dragging');
      
      const onMouseMove = (e) => {
        const delta = e.clientY - startY;
        const totalHeight = startEditorHeight + startConsoleHeight;
        const newEditorHeight = Math.max(100, Math.min(totalHeight - 100, startEditorHeight + delta));
        const newConsoleHeight = totalHeight - newEditorHeight;
        
        editorPanel.style.flex = `0 0 ${newEditorHeight}px`;
        consolePanel.style.flex = `0 0 ${newConsoleHeight}px`;
      };
      
      const onMouseUp = () => {
        document.body.classList.remove('resizing-v');
        resizeV.classList.remove('dragging');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        if (editor) editor.refresh();
        if (consoleInput) consoleInput.refresh();
      };
      
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  // Vertical resize (help/plots)
  if (resizeVRight && helpPanel && plotsPanel) {
    resizeVRight.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHelpHeight = helpPanel.getBoundingClientRect().height;
      const startPlotsHeight = plotsPanel.getBoundingClientRect().height;
      
      document.body.classList.add('resizing-v');
      resizeVRight.classList.add('dragging');
      
      const onMouseMove = (e) => {
        const delta = e.clientY - startY;
        const totalHeight = startHelpHeight + startPlotsHeight;
        const newHelpHeight = Math.max(80, Math.min(totalHeight - 80, startHelpHeight + delta));
        const newPlotsHeight = totalHeight - newHelpHeight;
        
        helpPanel.style.flex = `0 0 ${newHelpHeight}px`;
        plotsPanel.style.flex = `0 0 ${newPlotsHeight}px`;
      };
      
      const onMouseUp = () => {
        document.body.classList.remove('resizing-v');
        resizeVRight.classList.remove('dragging');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };
      
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }
}

// ===== Event Listeners =====

function initEventListeners() {
  const runBtn = getElement('runBtn');
  const clearConsoleBtn = getElement('clearConsoleBtn');
  const clearHelpBtn = getElement('clearHelpBtn');
  const clearPlotsBtn = getElement('clearPlotsBtn');
  const plotPrev = getElement('plotPrev');
  const plotNext = getElement('plotNext');

  if (runBtn) runBtn.addEventListener('click', runFromEditor);
  if (clearConsoleBtn) clearConsoleBtn.addEventListener('click', clearConsole);
  if (clearHelpBtn) clearHelpBtn.addEventListener('click', clearHelp);
  if (clearPlotsBtn) clearPlotsBtn.addEventListener('click', clearPlots);

  // Plot navigation
  if (plotPrev) {
    plotPrev.addEventListener('click', () => {
      if (currentPlotIndex > 0) {
        currentPlotIndex--;
        updatePlotDisplay();
      }
    });
  }

  if (plotNext) {
    plotNext.addEventListener('click', () => {
      if (currentPlotIndex < plotImages.length - 1) {
        currentPlotIndex++;
        updatePlotDisplay();
      }
    });
  }

  // Keyboard navigation for plots
  document.addEventListener('keydown', (e) => {
    const inEditor = document.activeElement.closest('.CodeMirror');
    if (inEditor) return;
    
    if (e.key === 'ArrowLeft' && plotImages.length > 0 && currentPlotIndex > 0) {
      currentPlotIndex--;
      updatePlotDisplay();
    } else if (e.key === 'ArrowRight' && plotImages.length > 0 && currentPlotIndex < plotImages.length - 1) {
      currentPlotIndex++;
      updatePlotDisplay();
    }
  });
}

// ===== Initialization =====

function loadCodeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  return code ? decodeURIComponent(code) : '';
}

function init() {
  console.log('Initializing playground...');
  
  try {
    const initialCode = loadCodeFromUrl();
    initEditor(initialCode);
    initConsoleInput();
    
    if (consoleInput) {
      consoleInput.setOption('readOnly', true);
    }
    
    initResize();
    initEventListeners();
    initWebR();
    
    console.log('Initialization complete');
  } catch (error) {
    console.error('Initialization error:', error);
    setStatus('error', 'Initialization failed');
  }
}

// Start the app
init();