import { cli, Strategy } from '@jackwener/opencli/registry';

export const autoReplyCommand = cli({
  site: 'channels',
  name: 'auto_reply',
  description: '自动遍历视频号评论，发现包含“意思”的评论自动回复“欢迎观看这个视频谢谢”',
  domain: 'channels.weixin.qq.com',
  strategy: Strategy.UI,
  browser: true,
  args: [
    { name: 'limit', type: 'int', default: 20, help: '最大处理视频数' },
  ],
  columns: ['video_title', 'user', 'comment', 'status'],
  func: async (page, kwargs) => {
    console.log("🚀 开始执行自动回复任务，限制视频数：", kwargs.limit);
    // 步骤一：跳转到评论管理页面
    console.log("跳转到互动管理页面...");
    await page.goto('https://channels.weixin.qq.com/platform/interaction/comment', { settleMs: 5000 });
    console.log("等待页面加载...");
    await new Promise(r => setTimeout(r, 4000));
    console.log("开始注入脚本执行...");
    
    const results = await page.evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const iframe = document.querySelector("iframe");
      if (!iframe || !iframe.contentDocument) return [{ error: '未找到后台 iframe' }];
      const doc = iframe.contentDocument;
      
      const videoEls = Array.from(doc.querySelectorAll(".comment-feed-wrap"));
      if (videoEls.length === 0) return [{ error: '未找到视频列表' }];
      
      const limit = Math.min(videoEls.length, ${kwargs.limit});
      const actionLogs = [];
      
      for (let i = 0; i < limit; i++) {
        // 点击左侧视频列表，加载右侧评论
        videoEls[i].click();
        await wait(2000);
        
        const currentVideoEls = Array.from(doc.querySelectorAll(".comment-feed-wrap"));
        const videoTitle = currentVideoEls[i]?.querySelector(".feed-title")?.innerText || "未知";
        
        const commentEls = Array.from(doc.querySelectorAll(".comment-item"));
        
        for (const el of commentEls) {
          const user = el.querySelector(".comment-user-name")?.innerText || "未知";
          const contentEl = el.querySelector(".comment-content");
          let content = contentEl?.innerText || "";
          if (!content.trim()) {
             const img = contentEl?.querySelector("img");
             if (img) content = img.alt || "[图片]";
          }
          
          // 如果评论中包含“意思”
          if (content.includes("意思")) {
            // 找到回复按钮并点击（直接点击图标本身更稳定）
            const replyBtn = el.querySelector(".weui-icon-outlined-comment");
            if (replyBtn) {
              // 确保元素可见
              try { replyBtn.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(e){}
              await wait(500);
              
              // 使用 dispatchEvent 模拟最真实的点击
              replyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: iframe.contentWindow }));
              replyBtn.click(); // 双重保险
              
              await wait(1500); // 增加等待时间，防止网络或渲染卡顿导致输入框还没出来
              
              const textarea = el.querySelector("textarea");
              if (textarea) {
                // 强制写入内容并触发 input 事件，这在 React/Vue 中是必须的，否则“评论”按钮可能不会被激活
                const iframeWindow = iframe.contentWindow;
                const nativeInputValueSetter = iframeWindow ? Object.getOwnPropertyDescriptor(iframeWindow.HTMLTextAreaElement.prototype, "value")?.set : null;
                if (nativeInputValueSetter) {
                  nativeInputValueSetter.call(textarea, "欢迎观看这个视频谢谢");
                } else {
                  textarea.value = "欢迎观看这个视频谢谢";
                }
                textarea.dispatchEvent(new Event("input", { bubbles: true }));
                
                await wait(800);
                
                // 查找并点击发送按钮，微信的发送按钮一般是包含 primary 类的 .tag-wrap
                const submitBtn = Array.from(el.querySelectorAll(".tag-wrap")).find(b => b.className.includes("primary"));
                if (submitBtn && !submitBtn.className.includes("disabled")) {
                  submitBtn.click();
                  actionLogs.push({ video_title: videoTitle, user, comment: content, status: '✅ 已回复' });
                  await wait(1500); // 等待回复请求发送完毕
                } else {
                  actionLogs.push({ video_title: videoTitle, user, comment: content, status: '⚠️ 发送按钮未激活或未找到' });
                }
              } else {
                 actionLogs.push({ video_title: videoTitle, user, comment: content, status: '❌ 未找到输入框' });
              }
            } else {
               actionLogs.push({ video_title: videoTitle, user, comment: content, status: '❌ 未找到回复按钮' });
            }
          }
        }
      }
      
      return actionLogs;
    })()`);
    
    // @ts-ignore
    if (results && results.length > 0 && results[0].error) {
      // @ts-ignore
      throw new Error(results[0].error);
    }
    
    // 如果没有动作日志，返回一个默认空提示以确保表格能渲染
    if (!results || results.length === 0) {
      return [{ video_title: '无', user: '无', comment: '无', status: '没有找到任何需要回复的评论' }];
    }
    
    return results;
  },
});