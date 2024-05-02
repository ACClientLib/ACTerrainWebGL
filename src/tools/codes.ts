let codeEntrybufferArray: string[] = [];
let lastKeystrokeTime = Date.now();

const codes: Record<string, [()=>undefined]> = {}

export function setupCodes() {
  addEventListener("keyup", e => {
    const key = e.key.toLowerCase();
    const latestKeystrokeTime = Date.now();
  
    if (latestKeystrokeTime - lastKeystrokeTime > 1000) {
      codeEntrybufferArray = [];
    }
  
    codeEntrybufferArray.push(key);
  
    const word = codeEntrybufferArray.join("");
    if (Array.isArray(codes[word])) {
      for (const handler of codes[word]) {
        handler();
      }
    }
  
    lastKeystrokeTime = latestKeystrokeTime;
  });
}

export function addCode(code: string, handler: ()=>undefined) {
  code = code.toLowerCase()
  
  if (!Array.isArray(codes[code])) {
    codes[code] = [handler]
  }
  else {
    codes[code].push(handler);
  }
}