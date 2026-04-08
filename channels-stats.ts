import { cli, Strategy } from '@jackwener/opencli/registry';
import mysql from 'mysql2/promise';

export const statsCommand = cli({
  site: 'channels',
  name: 'stats',
  description: '获取微信视频号后台所有视频的统计数据（访问量、评论数、点赞数等）及评论列表，包含封面和头像',
  domain: 'channels.weixin.qq.com',
  strategy: Strategy.UI,
  browser: true,
  args: [
    { name: 'limit', type: 'int', default: 20, help: '最大抓取视频数' },
  ],
  columns: ['title', 'time', 'views', 'likes', 'comments_count', 'shares', 'thumbs', 'cover'],
  func: async (page, kwargs) => {
    // 步骤一：在视频管理列表页抓取视频元数据（包含封面）
    await page.goto('https://channels.weixin.qq.com/platform/post/list?tab=post', { settleMs: 5000 });
    await new Promise(r => setTimeout(r, 4000));
    
    const videosStats = await page.evaluate(`(async () => {
      try {
        const iframe = document.querySelector("iframe");
        if (!iframe || !iframe.contentDocument) return { error: '未找到后台 iframe' };
        const doc = iframe.contentDocument;
        
        const videoEls = Array.from(doc.querySelectorAll(".post-feed-item"));
        if (videoEls.length === 0) return { error: '未找到视频列表' };
        
        const limit = Math.min(videoEls.length, ${kwargs.limit});
        const results = [];
        
        for (let i = 0; i < limit; i++) {
          const item = videoEls[i];
          const title = item.querySelector(".post-title")?.innerText || "未知";
          const time = item.querySelector(".post-time")?.innerText || "";
          const cover = item.querySelector("img.thumb")?.src || "";
          const dataItems = Array.from(item.querySelectorAll(".data-item"));
          
          results.push({
            title,
            time,
            cover,
            views: dataItems[0]?.querySelector(".count")?.innerText || "0",
            likes: dataItems[1]?.querySelector(".count")?.innerText || "0",
            comments_count: dataItems[2]?.querySelector(".count")?.innerText || "0",
            shares: dataItems[3]?.querySelector(".count")?.innerText || "0",
            thumbs: dataItems[4]?.querySelector(".count")?.innerText || "0"
          });
        }
        
        return { data: results };
      } catch (e) {
        return { error: e.message };
      }
    })()`);
    
    if (videosStats && typeof videosStats === 'object' && 'error' in videosStats && videosStats.error) {
      throw new Error('抓取视频列表失败: ' + videosStats.error);
    }
    
    const statsList = (videosStats && typeof videosStats === 'object' && 'data' in videosStats ? videosStats.data : []) || [];

    // 步骤二：跳转到评论管理页面抓取所有评论（包含头像）
    await page.goto('https://channels.weixin.qq.com/platform/interaction/comment', { settleMs: 5000 });
    await new Promise(r => setTimeout(r, 4000));
    
    const commentsData = await page.evaluate(`(async () => {
      try {
        const iframe = document.querySelector("iframe");
        if (!iframe || !iframe.contentDocument) return { error: '未找到后台 iframe' };
        const doc = iframe.contentDocument;
        
        const videoEls = Array.from(doc.querySelectorAll(".comment-feed-wrap"));
        if (videoEls.length === 0) return { error: '未找到视频列表' };
        
        let allComments = [];
        const limit = Math.min(videoEls.length, ${kwargs.limit});
        
        for (let i = 0; i < limit; i++) {
          videoEls[i].click();
          await new Promise(r => setTimeout(r, 2000));
          
          const currentVideoEls = Array.from(doc.querySelectorAll(".comment-feed-wrap"));
          const title = currentVideoEls[i]?.querySelector(".feed-title")?.innerText || "未知";
          
          const commentEls = Array.from(doc.querySelectorAll(".comment-item"));
          const comments = commentEls.map(el => {
            const user = el.querySelector(".comment-user-name")?.innerText || "";
            const time = el.querySelector(".comment-time")?.innerText || "";
            const avatar = el.querySelector("img.comment-avatar")?.src || "";
            const contentEl = el.querySelector(".comment-content");
            let content = contentEl?.innerText || "";
            
            if (!content.trim()) {
              const img = contentEl?.querySelector("img");
              if (img) content = img.alt || "[图片]";
            }
            
            return {
              user,
              avatar,
              time,
              content: content.trim()
            };
          });
          
          allComments.push({
            title,
            comments
          });
        }
        
        return { data: allComments };
      } catch (e) {
        return { error: e.message };
      }
    })()`);
    
    if (commentsData && typeof commentsData === 'object' && 'error' in commentsData && commentsData.error) {
      throw new Error('抓取评论失败: ' + commentsData.error);
    }
    
    const commentsList = (commentsData && typeof commentsData === 'object' && 'data' in commentsData ? commentsData.data : []) || [];
    
    // 步骤三：合并数据，将每个视频的详细统计信息与其对应的评论列表关联
    const finalResults = statsList.map((stat: any) => {
      // 尝试在评论数据中寻找相同标题的视频
      const matchedCommentData = commentsList.find((c: any) => c.title === stat.title);
      return {
        ...stat,
        comments_list: matchedCommentData ? matchedCommentData.comments : []
      };
    });

    // 步骤四：将数据写入数据库
    try {
      const connection = await mysql.createConnection({
        host: '10.1.28.16',
        port: 3306,
        user: 'root',
        password: 'root',
        charset: 'utf8mb4' // Node.js mysql2 驱动使用 utf8mb4 才能发送完整的多字节字符（如emoji和复杂汉字）
      });

      // 创建数据库（如果不存在），强制使用 utf8mb4，因为微信昵称和表情符号经常使用 4 字节的 Unicode 字符
      await connection.query('CREATE DATABASE IF NOT EXISTS daishuyifu CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
      await connection.query('USE daishuyifu');
      // 强制当前会话使用 utf8mb4
      await connection.query('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci');
      
      // 修改整个数据库字符集和已有表的字符集（以防之前创建的表还是老字符集）
      await connection.query('ALTER DATABASE daishuyifu CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
      try {
        await connection.query('ALTER TABLE video_stats CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
        await connection.query('ALTER TABLE video_comments CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
      } catch(e) {} // 忽略表不存在的错误

      // 创建视频统计表，所有文本字段都使用 utf8mb4_unicode_ci
      await connection.query(`
        CREATE TABLE IF NOT EXISTS video_stats (
          id INT AUTO_INCREMENT PRIMARY KEY,
          title VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
          time VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
          views INT DEFAULT 0,
          likes INT DEFAULT 0,
          comments_count INT DEFAULT 0,
          shares INT DEFAULT 0,
          thumbs INT DEFAULT 0,
          cover VARCHAR(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY unique_title_time (title, time)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
      `);

      // 创建评论表，所有文本字段都使用 utf8mb4_unicode_ci
      await connection.query(`
        CREATE TABLE IF NOT EXISTS video_comments (
          id INT AUTO_INCREMENT PRIMARY KEY,
          video_id INT NOT NULL,
          user VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
          time VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
          content TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
          avatar VARCHAR(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (video_id) REFERENCES video_stats(id) ON DELETE CASCADE
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
      `);

      // 插入数据
      for (const result of finalResults) {
        // 处理标题，去除非法字符或表情符号（将非基础多语言平面的字符即emoji全部替换掉，并确保只剩下基础字符）
        const safeTitle = result.title.replace(/[^\u0000-\uFFFF]/g, '').replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '');

        // 插入视频数据，使用 INSERT IGNORE 或 ON DUPLICATE KEY UPDATE 避免重复
        const [videoResult] = await connection.query(`
          INSERT INTO video_stats (title, time, views, likes, comments_count, shares, thumbs, cover)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE 
            views = VALUES(views),
            likes = VALUES(likes),
            comments_count = VALUES(comments_count),
            shares = VALUES(shares),
            thumbs = VALUES(thumbs),
            cover = VALUES(cover)
        `, [
          safeTitle,
          result.time,
          parseInt(result.views) || 0,
          parseInt(result.likes) || 0,
          parseInt(result.comments_count) || 0,
          parseInt(result.shares) || 0,
          parseInt(result.thumbs) || 0,
          result.cover
        ]);

        let videoId;
        if ('insertId' in videoResult && videoResult.insertId > 0) {
           videoId = videoResult.insertId;
        } else {
           // 如果没有 insertId，说明触发了 ON DUPLICATE KEY UPDATE，需要查询查出 id
           const [rows] = await connection.query('SELECT id FROM video_stats WHERE title = ? AND time = ?', [safeTitle, result.time]);
           videoId = (rows as any[])[0].id;
        }

        // 插入评论数据前，可以先清理旧的评论或者通过唯一键去重。这里选择简单清理重新插入
        await connection.query('DELETE FROM video_comments WHERE video_id = ?', [videoId]);

        if (result.comments_list && result.comments_list.length > 0) {
          const commentValues = result.comments_list.map((c: any) => [
            videoId,
            c.user.replace(/[^\u0000-\uFFFF]/g, '').replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''),
            c.time,
            c.content.replace(/[^\u0000-\uFFFF]/g, '').replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''),
            c.avatar
          ]);
          
          await connection.query(`
            INSERT INTO video_comments (video_id, user, time, content, avatar)
            VALUES ?
          `, [commentValues]);
        }
      }

      await connection.end();
      console.log('✅ 成功将数据写入数据库 10.1.28.16:3306');
    } catch (dbError) {
      console.error('❌ 写入数据库失败:', dbError);
    }
    
    return finalResults;
  },
});
