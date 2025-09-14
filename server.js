const express = require('express');
const { GoogleAuth } = require('google-auth-library');
const { google } = require('googleapis');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const session = require('express-session');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 认证配置
const AUTH_PASSWORD = process.env.AUTH_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

// 验证必需的环境变量
const requiredEnvVars = {
  GOOGLE_SHEETS_ID: process.env.GOOGLE_SHEETS_ID,
  GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  AUTH_PASSWORD: process.env.AUTH_PASSWORD,
  SESSION_SECRET: process.env.SESSION_SECRET
};

const missingVars = [];
const warningVars = [];

// 检查必需的环境变量
if (!requiredEnvVars.GOOGLE_SHEETS_ID || requiredEnvVars.GOOGLE_SHEETS_ID === 'your_google_sheets_id_here') {
  missingVars.push('GOOGLE_SHEETS_ID');
}

if (!requiredEnvVars.GOOGLE_APPLICATION_CREDENTIALS) {
  missingVars.push('GOOGLE_APPLICATION_CREDENTIALS');
}

if (!requiredEnvVars.AUTH_PASSWORD || requiredEnvVars.AUTH_PASSWORD === 'demo-password-change-me') {
  warningVars.push('AUTH_PASSWORD');
}

if (!requiredEnvVars.SESSION_SECRET || requiredEnvVars.SESSION_SECRET === 'your-session-secret-key' || requiredEnvVars.SESSION_SECRET.length < 32) {
  missingVars.push('SESSION_SECRET (must be at least 32 characters)');
}

// 显示错误和警告
if (missingVars.length > 0) {
  console.error('❌ ERROR: Missing required environment variables:');
  missingVars.forEach(varName => {
    console.error(`   - ${varName}`);
  });
  console.error('\n   Please check your .env file and set all required variables.');
  console.error('   See README.md or .env.example for configuration details.\n');
  process.exit(1);
}

if (warningVars.length > 0) {
  console.warn('⚠️  WARNING: Using default/insecure values for:');
  warningVars.forEach(varName => {
    console.warn(`   - ${varName}`);
  });
  console.warn('   Please update these for production use.\n');
}

// CORS 配置
const corsOptions = {
  credentials: true,
  origin: process.env.CORS_ORIGIN ? 
    (process.env.CORS_ORIGIN === '*' ? true : process.env.CORS_ORIGIN.split(',')) : 
    (process.env.NODE_ENV === 'production' ? false : true),
  optionsSuccessStatus: 200
};

// 中间件
app.use(cors(corsOptions));
app.use(bodyParser.json());

// Session 配置
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.COOKIE_SECURE === 'true',
    httpOnly: true, // 防止 XSS 攻击
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7天
    sameSite: 'lax' // CSRF 保护
  },
  name: 'diary.sid' // 自定义 session 名称
}));

// 应用配置
const CONFIG = {
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  THOUGHTS_PER_PAGE: parseInt(process.env.THOUGHTS_PER_PAGE) || 10,
  MAX_CONTENT_LENGTH: parseInt(process.env.MAX_CONTENT_LENGTH) || 10000,
  REQUEST_TIMEOUT: 10000,
  MAX_RETRIES: 3
};

// 认证中间件
const requireAuth = (req, res, next) => {
  if (req.session && req.session.authenticated) {
    return next();
  } else {
    return res.status(401).json({ error: 'Authentication required' });
  }
};

// 静态文件中间件
app.use(express.static('public'));

// Google Sheets 配置
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID;
let SHEET_NAME = 'Thoughts'; // 默认工作表名称
let SHEET_ID = 0; // 工作表ID

// Google 认证
async function getGoogleSheetsInstance() {
  try {
    const auth = new GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS || './service-account-key.json',
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient, timeout: CONFIG.REQUEST_TIMEOUT });
    return sheets;
  } catch (error) {
    console.error('Failed to initialize Google Sheets:', error.message);
    throw new Error('Google Sheets authentication failed');
  }
}

// 重试机制
async function retryOperation(operation, maxRetries = CONFIG.MAX_RETRIES) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      console.error(`Attempt ${attempt} failed:`, error.message);
      
      if (attempt === maxRetries) {
        throw error;
      }
      
      // 指数退让
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// 获取工作表信息（包括名称和ID）
async function getSheetInfo() {
  try {
    const sheets = await getGoogleSheetsInstance();
    const response = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
    });
    
    const sheetsList = response.data.sheets;
    if (sheetsList && sheetsList.length > 0) {
      // 优先使用 Thoughts 工作表，如果不存在则使用第一个工作表
      const thoughtsSheet = sheetsList.find(sheet => 
        sheet.properties.title.toLowerCase() === 'thoughts'
      );
      
      if (thoughtsSheet) {
        return {
          name: thoughtsSheet.properties.title,
          id: thoughtsSheet.properties.sheetId
        };
      } else {
        // 如果没有 Thoughts 工作表，使用第一个工作表
        return {
          name: sheetsList[0].properties.title,
          id: sheetsList[0].properties.sheetId
        };
      }
    }
    return { name: 'Sheet1', id: 0 }; // 默认值
  } catch (error) {
    console.error('Error getting sheet info:', error);
    return { name: 'Sheet1', id: 0 }; // 出错时返回默认值
  }
}

// 初始化工作表信息
async function initializeSheetInfo() {
  const sheetInfo = await getSheetInfo();
  SHEET_NAME = sheetInfo.name;
  SHEET_ID = sheetInfo.id;
  console.log(`Using sheet: ${SHEET_NAME} (ID: ${SHEET_ID})`);
}

// 认证路由
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  
  if (password === AUTH_PASSWORD) {
    req.session.authenticated = true;
    res.json({ success: true, message: 'Login successful' });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Could not log out' });
    }
    res.json({ success: true, message: 'Logout successful' });
  });
});

app.get('/api/auth/status', (req, res) => {
  res.json({ 
    authenticated: !!(req.session && req.session.authenticated),
    hasPassword: !!AUTH_PASSWORD && AUTH_PASSWORD !== 'your-secret-password'
  });
});

// 主页路由 - 指向育儿提醒应用
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reminder-app.html'));
});

// 存档工作表配置
const ARCHIVE_SHEET_NAME = 'ArchivedThoughts';

// 育儿提醒应用工作表配置
const CHILDREN_SHEET_NAME = 'Children';
const REMINDERS_SHEET_NAME = 'Reminders';
const RECORDS_SHEET_NAME = 'Records';
const CATEGORIES_SHEET_NAME = 'Categories';


// 初始化存档工作表
async function initializeArchiveSheet() {
  try {
    const sheets = await getGoogleSheetsInstance();
    const response = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
    });
    
    const existingSheets = response.data.sheets.map(sheet => sheet.properties.title);
    
    // 检查并创建ArchivedThoughts工作表
    if (!existingSheets.includes(ARCHIVE_SHEET_NAME)) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          requests: [{
            addSheet: {
              properties: { title: ARCHIVE_SHEET_NAME }
            }
          }]
        }
      });
      console.log(`Created archive sheet: ${ARCHIVE_SHEET_NAME}`);
      
      // 初始化表头
      await initializeArchiveSheetHeaders();
    }
  } catch (error) {
    console.error('Error initializing archive sheet:', error);
  }
}

// 初始化存档工作表的表头
async function initializeArchiveSheetHeaders() {
  try {
    const sheets = await getGoogleSheetsInstance();
    
    // ArchivedThoughts表头: Content | Timestamp | Date | ArchivedAt
    const archiveHeaders = [['Content', 'Timestamp', 'Date', 'ArchivedAt']];
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${ARCHIVE_SHEET_NAME}!A1:D1`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: archiveHeaders
      }
    });
    
    // 格式化表头为粗体
    const archiveSheetId = await getSheetIdByName(ARCHIVE_SHEET_NAME);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: {
        requests: [{
          updateCells: {
            range: {
              sheetId: archiveSheetId,
              startRowIndex: 0,
              endRowIndex: 1,
              startColumnIndex: 0,
              endColumnIndex: 4
            },
            rows: archiveHeaders.map(row => ({
              values: row.map(cell => ({
                userEnteredValue: { stringValue: cell },
                userEnteredFormat: { textFormat: { bold: true } }
              }))
            })),
            fields: 'userEnteredValue,userEnteredFormat.textFormat.bold'
          }
        }]
      }
    });
  } catch (error) {
    console.error('Error initializing archive headers:', error);
  }
}

// 初始化事件链工作表的表头

// 根据工作表名称获取ID
async function getSheetIdByName(sheetName) {
  try {
    const sheets = await getGoogleSheetsInstance();
    const response = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
    });
    
    const sheet = response.data.sheets.find(s => s.properties.title === sheetName);
    return sheet ? sheet.properties.sheetId : 0;
  } catch (error) {
    console.error('Error getting sheet ID:', error);
    return 0;
  }
}

// 缓存管理
let thoughtsCache = {
  data: null,
  lastFetch: 0,
  ttl: 30000 // 30秒缓存
};

// 获取想法（支持真分页和缓存）
app.get('/api/thoughts', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || CONFIG.THOUGHTS_PER_PAGE, 50); // 限制最大数量
    const offset = (page - 1) * limit;
    const forceRefresh = req.query.refresh === 'true';

    // 检查缓存
    const now = Date.now();
    const cacheValid = thoughtsCache.data && 
                      (now - thoughtsCache.lastFetch < thoughtsCache.ttl) && 
                      !forceRefresh;

    let allThoughts;
    if (cacheValid) {
      allThoughts = thoughtsCache.data;
    } else {
      // 获取新数据
      const operation = async () => {
        const sheets = await getGoogleSheetsInstance();
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `${SHEET_NAME}!A:C`,
        });
        return response.data.values || [];
      };

      const rows = await retryOperation(operation);
      
      // 处理数据
      allThoughts = rows.slice(1).map((row, index) => ({
        id: index, // 使用数组索引作为ID（从0开始）
        content: row[0] || '',
        timestamp: row[1] || '',
        date: row[2] || ''
      })).reverse(); // 最新的在前面
      
      // 更新缓存
      thoughtsCache.data = allThoughts;
      thoughtsCache.lastFetch = now;
    }

    const totalCount = allThoughts.length;
    const thoughts = allThoughts.slice(offset, offset + limit);
    const hasMore = offset + limit < totalCount;

    res.json({
      thoughts,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
        hasMore
      },
      cached: cacheValid
    });
  } catch (error) {
    console.error('Error fetching thoughts:', error);
    
    // 根据错误类型返回不同的错误信息
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      res.status(503).json({ error: 'Service temporarily unavailable' });
    } else if (error.message.includes('authentication')) {
      res.status(500).json({ error: 'Authentication error' });
    } else if (error.message.includes('not found')) {
      res.status(404).json({ error: 'Sheet not found' });
    } else {
      res.status(500).json({ error: 'Failed to fetch thoughts' });
    }
  }
});

// 清除缓存的工具函数
function clearThoughtsCache() {
  thoughtsCache.data = null;
  thoughtsCache.lastFetch = 0;
}

// 添加新想法
app.post('/api/thoughts', requireAuth, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || content.trim() === '') {
      return res.status(400).json({ error: 'Content is required' });
    }
    
    // 验证内容长度
    if (content.length > CONFIG.MAX_CONTENT_LENGTH) {
      return res.status(400).json({ 
        error: `Content too long. Maximum ${CONFIG.MAX_CONTENT_LENGTH} characters allowed.` 
      });
    }

    const sheets = await getGoogleSheetsInstance();
    const timestamp = new Date().toLocaleString('zh-CN');
    const date = new Date().toLocaleDateString('zh-CN');

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:C`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[content.trim(), timestamp, date]]
      },
    });

    // 清除缓存以确保数据一致性
    clearThoughtsCache();
    
    res.json({ 
      message: 'Thought added successfully',
      content: content.trim(),
      timestamp,
      date
    });
  } catch (error) {
    console.error('Error adding thought:', error);
    res.status(500).json({ error: 'Failed to add thought' });
  }
});

// 工具函数：计算真实的行索引
function calculateRowIndex(frontendIndex, totalDataRows) {
  // 前端使用20分页显示，索引从0开始，最新的在前
  // 后端数据在Google Sheets中是按时间顺序存储的，最新的在后
  
  if (frontendIndex < 0 || frontendIndex >= totalDataRows) {
    return null; // 无效索引
  }
  
  // 计算实际行号（从Google Sheets的角度）
  // frontendIndex=0 -> 最后一行数据 -> totalDataRows
  // frontendIndex=1 -> 倒数第二行数据 -> totalDataRows-1  
  const dataRowIndex = totalDataRows - frontendIndex; // 1-based，不包含标题行
  const sheetRowIndex = dataRowIndex + 1; // 加上标题行
  
  return {
    dataRowIndex,    // 数据行索引（1-based，不含标题）
    sheetRowIndex,   // Google Sheets行索引（1-based，含标题）
    arrayIndex: dataRowIndex // 数组索引（包含标题行）
  };
}

// 更新想法
app.put('/api/thoughts/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;
    
    if (!content || content.trim() === '') {
      return res.status(400).json({ error: 'Content is required' });
    }
    
    // 验证内容长度
    if (content.length > CONFIG.MAX_CONTENT_LENGTH) {
      return res.status(400).json({ 
        error: `Content too long. Maximum ${CONFIG.MAX_CONTENT_LENGTH} characters allowed.` 
      });
    }

    const frontendIndex = parseInt(id);
    if (isNaN(frontendIndex)) {
      return res.status(400).json({ error: 'Invalid thought ID' });
    }

    const operation = async () => {
      const sheets = await getGoogleSheetsInstance();
      
      // 获取当前数据
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:C`,
      });

      const rows = response.data.values || [];
      const totalDataRows = rows.length - 1; // 减去标题行
      
      // 计算索引
      const indexInfo = calculateRowIndex(frontendIndex, totalDataRows);
      if (!indexInfo) {
        throw new Error('Thought not found');
      }
      
      console.log(`Updating thought - Frontend ID: ${frontendIndex}, Sheet row: ${indexInfo.sheetRowIndex}`);

      // 保持原有时间戳
      const originalTimestamp = rows[indexInfo.arrayIndex][1] || new Date().toLocaleString('zh-CN');
      const originalDate = rows[indexInfo.arrayIndex][2] || new Date().toLocaleDateString('zh-CN');
      
      // 更新数据
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A${indexInfo.sheetRowIndex}:C${indexInfo.sheetRowIndex}`,
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[content.trim(), originalTimestamp, originalDate]]
        }
      });

      return { originalTimestamp, originalDate };
    };

    const result = await retryOperation(operation);
    
    // 清除缓存以确保数据一致性
    clearThoughtsCache();
    
    res.json({ 
      message: 'Thought updated successfully',
      content: content.trim(),
      timestamp: result.originalTimestamp,
      date: result.originalDate
    });
  } catch (error) {
    console.error('Error updating thought:', error);
    
    if (error.message === 'Thought not found') {
      res.status(404).json({ error: 'Thought not found' });
    } else if (error.message.includes('authentication')) {
      res.status(500).json({ error: 'Authentication error' });
    } else {
      res.status(500).json({ error: 'Failed to update thought' });
    }
  }
});

// 删除想法
app.delete('/api/thoughts/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const frontendIndex = parseInt(id);
    
    if (isNaN(frontendIndex)) {
      return res.status(400).json({ error: 'Invalid thought ID' });
    }

    const operation = async () => {
      const sheets = await getGoogleSheetsInstance();
      
      // 获取当前数据
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:C`,
      });

      const rows = response.data.values || [];
      const totalDataRows = rows.length - 1; // 减去标题行
      
      // 计算索引
      const indexInfo = calculateRowIndex(frontendIndex, totalDataRows);
      if (!indexInfo) {
        throw new Error('Thought not found');
      }
      
      console.log(`Deleting thought - Frontend ID: ${frontendIndex}, Sheet row: ${indexInfo.sheetRowIndex}`);

      // 删除指定行（注意：batchUpdate 使用的是 0-based 索引）
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          requests: [{
            deleteDimension: {
              range: {
                sheetId: SHEET_ID,
                dimension: 'ROWS',
                startIndex: indexInfo.sheetRowIndex - 1, // 转为 0-based
                endIndex: indexInfo.sheetRowIndex // 不包含 end，所以不用-1
              }
            }
          }]
        }
      });
    };

    await retryOperation(operation);
    
    // 清除缓存以确保数据一致性
    clearThoughtsCache();
    
    res.json({ message: 'Thought deleted successfully' });
  } catch (error) {
    console.error('Error deleting thought:', error);
    
    if (error.message === 'Thought not found') {
      res.status(404).json({ error: 'Thought not found' });
    } else if (error.message.includes('authentication')) {
      res.status(500).json({ error: 'Authentication error' });
    } else {
      res.status(500).json({ error: 'Failed to delete thought' });
    }
  }
});

// ==================== 存档 API 路由 ====================

// 存档缓存管理
let archiveCache = {
  data: null,
  lastFetch: 0,
  ttl: 30000 // 30秒缓存
};

// 清除存档缓存的工具函数
function clearArchiveCache() {
  archiveCache.data = null;
  archiveCache.lastFetch = 0;
}

// 存档想法
app.post('/api/thoughts/:id/archive', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const frontendIndex = parseInt(id);
    
    if (isNaN(frontendIndex)) {
      return res.status(400).json({ error: 'Invalid thought ID' });
    }

    const operation = async () => {
      const sheets = await getGoogleSheetsInstance();
      
      // 获取当前数据
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:C`,
      });

      const rows = response.data.values || [];
      const totalDataRows = rows.length - 1; // 减去标题行
      
      // 计算索引
      const indexInfo = calculateRowIndex(frontendIndex, totalDataRows);
      if (!indexInfo) {
        throw new Error('Thought not found');
      }
      
      console.log(`Archiving thought - Frontend ID: ${frontendIndex}, Sheet row: ${indexInfo.sheetRowIndex}`);

      const thoughtData = rows[indexInfo.arrayIndex];
      const archivedAt = new Date().toLocaleString('zh-CN');
      
      // 添加到存档工作表
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${ARCHIVE_SHEET_NAME}!A:D`,
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[thoughtData[0], thoughtData[1], thoughtData[2], archivedAt]]
        }
      });

      // 从主工作表中删除
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          requests: [{
            deleteDimension: {
              range: {
                sheetId: SHEET_ID,
                dimension: 'ROWS',
                startIndex: indexInfo.sheetRowIndex - 1, // 转为 0-based
                endIndex: indexInfo.sheetRowIndex
              }
            }
          }]
        }
      });

      return { content: thoughtData[0], timestamp: thoughtData[1], date: thoughtData[2], archivedAt };
    };

    const result = await retryOperation(operation);
    
    // 清除缓存以确保数据一致性
    clearThoughtsCache();
    clearArchiveCache();
    
    res.json({ 
      message: 'Thought archived successfully',
      ...result
    });
  } catch (error) {
    console.error('Error archiving thought:', error);
    
    if (error.message === 'Thought not found') {
      res.status(404).json({ error: 'Thought not found' });
    } else if (error.message.includes('authentication')) {
      res.status(500).json({ error: 'Authentication error' });
    } else {
      res.status(500).json({ error: 'Failed to archive thought' });
    }
  }
});

// 获取存档想法列表（支持分页）
app.get('/api/thoughts/archived', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || CONFIG.THOUGHTS_PER_PAGE, 50);
    const offset = (page - 1) * limit;
    const forceRefresh = req.query.refresh === 'true';

    // 检查缓存
    const now = Date.now();
    const cacheValid = archiveCache.data && 
                      (now - archiveCache.lastFetch < archiveCache.ttl) && 
                      !forceRefresh;

    let allArchivedThoughts;
    if (cacheValid) {
      allArchivedThoughts = archiveCache.data;
    } else {
      // 获取新数据
      const operation = async () => {
        const sheets = await getGoogleSheetsInstance();
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `${ARCHIVE_SHEET_NAME}!A:D`,
        });
        return response.data.values || [];
      };

      const rows = await retryOperation(operation);
      
      // 处理数据
      allArchivedThoughts = rows.slice(1).map((row, index) => ({
        id: index, // 使用数组索引作为ID（从0开始）
        content: row[0] || '',
        timestamp: row[1] || '',
        date: row[2] || '',
        archivedAt: row[3] || ''
      })).reverse(); // 最新的在前面
      
      // 更新缓存
      archiveCache.data = allArchivedThoughts;
      archiveCache.lastFetch = now;
    }

    const totalCount = allArchivedThoughts.length;
    const thoughts = allArchivedThoughts.slice(offset, offset + limit);
    const hasMore = offset + limit < totalCount;

    res.json({
      thoughts,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
        hasMore
      },
      cached: cacheValid
    });
  } catch (error) {
    console.error('Error fetching archived thoughts:', error);
    
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      res.status(503).json({ error: 'Service temporarily unavailable' });
    } else if (error.message.includes('authentication')) {
      res.status(500).json({ error: 'Authentication error' });
    } else if (error.message.includes('not found')) {
      res.status(404).json({ error: 'Archive sheet not found' });
    } else {
      res.status(500).json({ error: 'Failed to fetch archived thoughts' });
    }
  }
});

// 恢复想法（从存档恢复到主页）
app.post('/api/thoughts/:id/unarchive', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const frontendIndex = parseInt(id);
    
    if (isNaN(frontendIndex)) {
      return res.status(400).json({ error: 'Invalid archived thought ID' });
    }

    const operation = async () => {
      const sheets = await getGoogleSheetsInstance();
      
      // 获取存档数据
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${ARCHIVE_SHEET_NAME}!A:D`,
      });

      const rows = response.data.values || [];
      const totalDataRows = rows.length - 1; // 减去标题行
      
      // 计算索引（这里使用相同的逻辑，但是基于存档数据）
      const indexInfo = calculateRowIndex(frontendIndex, totalDataRows);
      if (!indexInfo) {
        throw new Error('Archived thought not found');
      }
      
      console.log(`Unarchiving thought - Frontend ID: ${frontendIndex}, Archive row: ${indexInfo.sheetRowIndex}`);

      const thoughtData = rows[indexInfo.arrayIndex];
      
      // 添加回主工作表
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:C`,
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[thoughtData[0], thoughtData[1], thoughtData[2]]]
        }
      });

      // 从存档工作表中删除
      const archiveSheetId = await getSheetIdByName(ARCHIVE_SHEET_NAME);
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          requests: [{
            deleteDimension: {
              range: {
                sheetId: archiveSheetId,
                dimension: 'ROWS',
                startIndex: indexInfo.sheetRowIndex - 1, // 转为 0-based
                endIndex: indexInfo.sheetRowIndex
              }
            }
          }]
        }
      });

      return { content: thoughtData[0], timestamp: thoughtData[1], date: thoughtData[2] };
    };

    const result = await retryOperation(operation);
    
    // 清除缓存以确保数据一致性
    clearThoughtsCache();
    clearArchiveCache();
    
    res.json({ 
      message: 'Thought unarchived successfully',
      ...result
    });
  } catch (error) {
    console.error('Error unarchiving thought:', error);
    
    if (error.message === 'Archived thought not found') {
      res.status(404).json({ error: 'Archived thought not found' });
    } else if (error.message.includes('authentication')) {
      res.status(500).json({ error: 'Authentication error' });
    } else {
      res.status(500).json({ error: 'Failed to unarchive thought' });
    }
  }
});

// ==================== 育儿提醒 API 路由 ====================

// 获取所有分类
app.get('/api/categories', requireAuth, async (req, res) => {
  try {
    const sheets = await getGoogleSheetsInstance();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${CATEGORIES_SHEET_NAME}!A:G`,
    });

    const rows = response.data.values || [];
    const categories = rows.slice(1).map(row => ({
      id: row[0],
      name: row[1],
      icon: row[2],
      color: row[3],
      order: parseInt(row[4]) || 0,
      description: row[5],
      createdAt: row[6]
    }));

    res.json({ categories });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// 获取所有孩子信息
app.get('/api/children', requireAuth, async (req, res) => {
  try {
    const sheets = await getGoogleSheetsInstance();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${CHILDREN_SHEET_NAME}!A:H`,
    });

    const rows = response.data.values || [];
    const children = rows.slice(1).map(row => ({
      id: row[0],
      name: row[1],
      age: row[2],
      birthday: row[3],
      avatar: row[4],
      createdAt: row[5],
      updatedAt: row[6],
      status: row[7] || 'active'
    }));

    res.json({ children });
  } catch (error) {
    console.error('Error fetching children:', error);
    res.status(500).json({ error: 'Failed to fetch children' });
  }
});

// 添加新孩子
app.post('/api/children', requireAuth, async (req, res) => {
  try {
    const { name, age, birthday, avatar } = req.body;

    if (!name || !age) {
      return res.status(400).json({ error: 'Name and age are required' });
    }

    const sheets = await getGoogleSheetsInstance();
    const id = Date.now().toString();
    const now = new Date().toISOString();

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${CHILDREN_SHEET_NAME}!A:H`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[id, name, age, birthday || '', avatar || '', now, now, 'active']]
      },
    });

    res.json({
      message: 'Child added successfully',
      child: { id, name, age, birthday, avatar, createdAt: now, updatedAt: now, status: 'active' }
    });
  } catch (error) {
    console.error('Error adding child:', error);
    res.status(500).json({ error: 'Failed to add child' });
  }
});

// 更新孩子信息
app.put('/api/children/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, age, birthday, avatar } = req.body;

    const sheets = await getGoogleSheetsInstance();

    // 获取当前数据
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${CHILDREN_SHEET_NAME}!A:H`,
    });

    const rows = response.data.values || [];
    const rowIndex = rows.findIndex(row => row[0] === id);

    if (rowIndex === -1) {
      return res.status(404).json({ error: 'Child not found' });
    }

    const updatedRow = rows[rowIndex];
    updatedRow[1] = name || updatedRow[1];
    updatedRow[2] = age || updatedRow[2];
    updatedRow[3] = birthday !== undefined ? birthday : updatedRow[3];
    updatedRow[4] = avatar !== undefined ? avatar : updatedRow[4];
    updatedRow[6] = new Date().toISOString();

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${CHILDREN_SHEET_NAME}!A${rowIndex + 1}:H${rowIndex + 1}`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [updatedRow]
      }
    });

    res.json({ message: 'Child updated successfully' });
  } catch (error) {
    console.error('Error updating child:', error);
    res.status(500).json({ error: 'Failed to update child' });
  }
});

// 获取提醒任务
app.get('/api/reminders', requireAuth, async (req, res) => {
  try {
    const { childId, date } = req.query;
    const sheets = await getGoogleSheetsInstance();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${REMINDERS_SHEET_NAME}!A:L`,
    });

    const rows = response.data.values || [];
    let reminders = rows.slice(1).map(row => ({
      id: row[0],
      childId: row[1],
      title: row[2],
      description: row[3],
      category: row[4],
      reminderType: row[5],
      reminderTime: row[6],
      repeatRule: row[7],
      advanceMinutes: parseInt(row[8]) || 0,
      enabled: row[9] === 'true' || row[9] === true,
      createdAt: row[10],
      updatedAt: row[11]
    }));

    // 根据查询参数过滤
    if (childId) {
      reminders = reminders.filter(r => r.childId === childId);
    }

    if (date) {
      // 根据日期过滤今日的提醒
      const targetDate = new Date(date);
      reminders = reminders.filter(r => {
        if (r.reminderType === 'once') {
          const reminderDate = new Date(r.reminderTime);
          return reminderDate.toDateString() === targetDate.toDateString();
        } else if (r.reminderType === 'daily') {
          return true; // 每日提醒都显示
        } else if (r.reminderType === 'weekly') {
          const reminderDate = new Date(r.reminderTime);
          return reminderDate.getDay() === targetDate.getDay();
        }
        return false;
      });
    }

    res.json({ reminders });
  } catch (error) {
    console.error('Error fetching reminders:', error);
    res.status(500).json({ error: 'Failed to fetch reminders' });
  }
});

// 添加新提醒
app.post('/api/reminders', requireAuth, async (req, res) => {
  try {
    const {
      childId, title, description, category,
      reminderType, reminderTime, repeatRule,
      advanceMinutes
    } = req.body;

    if (!childId || !title || !reminderType || !reminderTime) {
      return res.status(400).json({ error: 'Required fields missing' });
    }

    const sheets = await getGoogleSheetsInstance();
    const id = Date.now().toString();
    const now = new Date().toISOString();

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${REMINDERS_SHEET_NAME}!A:L`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          id, childId, title, description || '', category || '',
          reminderType, reminderTime, repeatRule || '',
          advanceMinutes || 0, true, now, now
        ]]
      },
    });

    res.json({
      message: 'Reminder added successfully',
      reminder: {
        id, childId, title, description, category,
        reminderType, reminderTime, repeatRule,
        advanceMinutes, enabled: true, createdAt: now, updatedAt: now
      }
    });
  } catch (error) {
    console.error('Error adding reminder:', error);
    res.status(500).json({ error: 'Failed to add reminder' });
  }
});

// 更新提醒状态
app.put('/api/reminders/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const sheets = await getGoogleSheetsInstance();

    // 获取当前数据
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${REMINDERS_SHEET_NAME}!A:L`,
    });

    const rows = response.data.values || [];
    const rowIndex = rows.findIndex(row => row[0] === id);

    if (rowIndex === -1) {
      return res.status(404).json({ error: 'Reminder not found' });
    }

    const updatedRow = rows[rowIndex];

    // 更新字段
    if (updates.title !== undefined) updatedRow[2] = updates.title;
    if (updates.description !== undefined) updatedRow[3] = updates.description;
    if (updates.category !== undefined) updatedRow[4] = updates.category;
    if (updates.reminderType !== undefined) updatedRow[5] = updates.reminderType;
    if (updates.reminderTime !== undefined) updatedRow[6] = updates.reminderTime;
    if (updates.repeatRule !== undefined) updatedRow[7] = updates.repeatRule;
    if (updates.advanceMinutes !== undefined) updatedRow[8] = updates.advanceMinutes;
    if (updates.enabled !== undefined) updatedRow[9] = updates.enabled;
    updatedRow[11] = new Date().toISOString();

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${REMINDERS_SHEET_NAME}!A${rowIndex + 1}:L${rowIndex + 1}`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [updatedRow]
      }
    });

    res.json({ message: 'Reminder updated successfully' });
  } catch (error) {
    console.error('Error updating reminder:', error);
    res.status(500).json({ error: 'Failed to update reminder' });
  }
});

// 删除提醒
app.delete('/api/reminders/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const sheets = await getGoogleSheetsInstance();

    // 获取当前数据
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${REMINDERS_SHEET_NAME}!A:L`,
    });

    const rows = response.data.values || [];
    const rowIndex = rows.findIndex(row => row[0] === id);

    if (rowIndex === -1) {
      return res.status(404).json({ error: 'Reminder not found' });
    }

    // 获取工作表ID
    const remindersSheetId = await getSheetIdByName(REMINDERS_SHEET_NAME);

    // 删除行
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId: remindersSheetId,
              dimension: 'ROWS',
              startIndex: rowIndex,
              endIndex: rowIndex + 1
            }
          }
        }]
      }
    });

    res.json({ message: 'Reminder deleted successfully' });
  } catch (error) {
    console.error('Error deleting reminder:', error);
    res.status(500).json({ error: 'Failed to delete reminder' });
  }
});

// 记录完成情况
app.post('/api/records', requireAuth, async (req, res) => {
  try {
    const { reminderId, childId, scheduledTime, status, note } = req.body;

    if (!reminderId || !childId || !scheduledTime) {
      return res.status(400).json({ error: 'Required fields missing' });
    }

    const sheets = await getGoogleSheetsInstance();
    const id = Date.now().toString();
    const completedTime = status === 'completed' ? new Date().toISOString() : '';
    const operator = req.session.user || 'User';
    const createdAt = new Date().toISOString();

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${RECORDS_SHEET_NAME}!A:I`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          id, reminderId, childId, scheduledTime,
          completedTime, status, note || '', operator, createdAt
        ]]
      },
    });

    res.json({
      message: 'Record added successfully',
      record: {
        id, reminderId, childId, scheduledTime,
        completedTime, status, note, operator, createdAt
      }
    });
  } catch (error) {
    console.error('Error adding record:', error);
    res.status(500).json({ error: 'Failed to add record' });
  }
});

// 获取完成记录
app.get('/api/records', requireAuth, async (req, res) => {
  try {
    const { childId, date, reminderId } = req.query;
    const sheets = await getGoogleSheetsInstance();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${RECORDS_SHEET_NAME}!A:I`,
    });

    const rows = response.data.values || [];
    let records = rows.slice(1).map(row => ({
      id: row[0],
      reminderId: row[1],
      childId: row[2],
      scheduledTime: row[3],
      completedTime: row[4],
      status: row[5],
      note: row[6],
      operator: row[7],
      createdAt: row[8]
    }));

    // 根据查询参数过滤
    if (childId) {
      records = records.filter(r => r.childId === childId);
    }

    if (reminderId) {
      records = records.filter(r => r.reminderId === reminderId);
    }

    if (date) {
      const targetDate = new Date(date).toDateString();
      records = records.filter(r => {
        const recordDate = new Date(r.scheduledTime).toDateString();
        return recordDate === targetDate;
      });
    }

    res.json({ records });
  } catch (error) {
    console.error('Error fetching records:', error);
    res.status(500).json({ error: 'Failed to fetch records' });
  }
});

// 获取统计数据
app.get('/api/statistics', requireAuth, async (req, res) => {
  try {
    const { childId, startDate, endDate } = req.query;
    const sheets = await getGoogleSheetsInstance();

    // 获取记录数据
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${RECORDS_SHEET_NAME}!A:I`,
    });

    const rows = response.data.values || [];
    let records = rows.slice(1).map(row => ({
      id: row[0],
      reminderId: row[1],
      childId: row[2],
      scheduledTime: row[3],
      completedTime: row[4],
      status: row[5],
      note: row[6],
      operator: row[7],
      createdAt: row[8]
    }));

    // 根据查询参数过滤
    if (childId) {
      records = records.filter(r => r.childId === childId);
    }

    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      records = records.filter(r => {
        const recordDate = new Date(r.scheduledTime);
        return recordDate >= start && recordDate <= end;
      });
    }

    // 计算统计数据
    const totalTasks = records.length;
    const completedTasks = records.filter(r => r.status === 'completed').length;
    const skippedTasks = records.filter(r => r.status === 'skipped').length;
    const pendingTasks = records.filter(r => r.status === 'pending').length;
    const completionRate = totalTasks > 0 ? (completedTasks / totalTasks * 100).toFixed(2) : 0;

    // 按类别统计（需要关联提醒数据）
    const reminderResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${REMINDERS_SHEET_NAME}!A:L`,
    });

    const reminderRows = reminderResponse.data.values || [];
    const remindersMap = {};
    reminderRows.slice(1).forEach(row => {
      remindersMap[row[0]] = {
        category: row[4],
        title: row[2]
      };
    });

    const categoryStats = {};
    records.forEach(record => {
      const reminder = remindersMap[record.reminderId];
      if (reminder && reminder.category) {
        if (!categoryStats[reminder.category]) {
          categoryStats[reminder.category] = {
            total: 0,
            completed: 0,
            skipped: 0,
            pending: 0
          };
        }
        categoryStats[reminder.category].total++;
        if (record.status === 'completed') {
          categoryStats[reminder.category].completed++;
        } else if (record.status === 'skipped') {
          categoryStats[reminder.category].skipped++;
        } else if (record.status === 'pending') {
          categoryStats[reminder.category].pending++;
        }
      }
    });

    res.json({
      statistics: {
        totalTasks,
        completedTasks,
        skippedTasks,
        pendingTasks,
        completionRate,
        categoryStats
      }
    });
  } catch (error) {
    console.error('Error fetching statistics:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// 搜索想法
app.get('/api/thoughts/search', requireAuth, async (req, res) => {
  try {
    const query = req.query.q || '';
    const searchType = req.query.type || 'all'; // 'main', 'archive', 'all'
    
    if (!query.trim()) {
      return res.json({
        thoughts: [],
        pagination: {
          totalCount: 0,
          hasMore: false
        }
      });
    }

    const searchQuery = query.trim().toLowerCase();
    let allResults = [];

    // 搜索主要想法
    if (searchType === 'main' || searchType === 'all') {
      try {
        const sheets = await getGoogleSheetsInstance();
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `${SHEET_NAME}!A:C`,
        });

        const rows = response.data.values || [];
        const mainThoughts = rows.slice(1).map((row, index) => ({
          id: index,
          content: row[0] || '',
          timestamp: row[1] || '',
          date: row[2] || '',
          type: 'main'
        }));

        // 过滤包含搜索关键词的想法
        const filteredMain = mainThoughts.filter(thought =>
          thought.content.toLowerCase().includes(searchQuery)
        );

        allResults.push(...filteredMain);
      } catch (error) {
        console.warn('Error searching main thoughts:', error);
      }
    }

    // 搜索存档想法
    if (searchType === 'archive' || searchType === 'all') {
      try {
        const sheets = await getGoogleSheetsInstance();
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `${ARCHIVE_SHEET_NAME}!A:D`,
        });

        const rows = response.data.values || [];
        const archiveThoughts = rows.slice(1).map((row, index) => ({
          id: index,
          content: row[0] || '',
          timestamp: row[1] || '',
          date: row[2] || '',
          archivedAt: row[3] || '',
          type: 'archive'
        }));

        // 过滤包含搜索关键词的想法
        const filteredArchive = archiveThoughts.filter(thought =>
          thought.content.toLowerCase().includes(searchQuery)
        );

        allResults.push(...filteredArchive);
      } catch (error) {
        console.warn('Error searching archived thoughts:', error);
      }
    }

    // 按时间戳降序排列
    allResults.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json({
      thoughts: allResults,
      pagination: {
        totalCount: allResults.length,
        hasMore: false
      },
      query: query
    });

  } catch (error) {
    console.error('Error searching thoughts:', error);
    res.status(500).json({ error: 'Failed to search thoughts' });
  }
});

// 健康检查端点
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// 初始化育儿提醒应用工作表
async function initializeReminderSheets() {
  try {
    const sheets = await getGoogleSheetsInstance();
    const response = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
    });

    const existingSheets = response.data.sheets.map(sheet => sheet.properties.title);
    const requiredSheets = [CHILDREN_SHEET_NAME, REMINDERS_SHEET_NAME, RECORDS_SHEET_NAME, CATEGORIES_SHEET_NAME];
    const requests = [];

    // 检查并创建缺失的工作表
    for (const sheetName of requiredSheets) {
      if (!existingSheets.includes(sheetName)) {
        requests.push({
          addSheet: {
            properties: {
              title: sheetName,
              gridProperties: { rowCount: 1000, columnCount: 20 }
            }
          }
        });
        console.log(`Will create sheet: ${sheetName}`);
      }
    }

    // 批量创建工作表
    if (requests.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: { requests }
      });
      console.log('Created missing sheets');

      // 初始化表头和默认数据
      const sheetConfigs = [
        {
          name: CHILDREN_SHEET_NAME,
          headers: [['ID', '姓名', '年龄', '生日', '头像', '创建时间', '更新时间', '状态']],
          data: []
        },
        {
          name: REMINDERS_SHEET_NAME,
          headers: [['ID', '孩子ID', '标题', '描述', '分类', '提醒类型', '提醒时间', '重复规则', '提前提醒(分钟)', '启用状态', '创建时间', '更新时间']],
          data: []
        },
        {
          name: RECORDS_SHEET_NAME,
          headers: [['ID', '提醒ID', '孩子ID', '计划时间', '完成时间', '状态', '备注', '操作人', '创建时间']],
          data: []
        },
        {
          name: CATEGORIES_SHEET_NAME,
          headers: [['ID', '分类名称', '图标', '颜色', '排序', '描述', '创建时间']],
          data: [
            ['1', '喝水', '💧', '#4FC3F7', '1', '定时提醒喝水', new Date().toISOString()],
            ['2', '维他命', '💊', '#66BB6A', '2', '维他命和营养补充剂', new Date().toISOString()],
            ['3', '刷牙', '🦷', '#FF7043', '3', '口腔卫生护理', new Date().toISOString()],
            ['4', '午睡', '😴', '#9575CD', '4', '休息和睡眠', new Date().toISOString()],
            ['5', '运动', '🏃', '#FFB74D', '5', '体育锻炼活动', new Date().toISOString()],
            ['6', '补铁剂', '🩸', '#F06292', '6', '铁剂补充', new Date().toISOString()],
            ['7', '吃药', '💉', '#EF5350', '7', '药物服用提醒', new Date().toISOString()],
            ['8', '作业', '📚', '#5C6BC0', '8', '学习任务提醒', new Date().toISOString()],
            ['9', '其他', '📌', '#78909C', '9', '其他提醒事项', new Date().toISOString()]
          ]
        }
      ];

      // 写入表头和数据
      for (const config of sheetConfigs) {
        const values = [...config.headers, ...config.data];
        if (values.length > 0) {
          await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${config.name}!A1`,
            valueInputOption: 'RAW',
            resource: { values }
          });
          console.log(`Initialized ${config.name} with headers and data`);
        }
      }
    }

    console.log('Reminder sheets initialization completed');
  } catch (error) {
    console.error('Error initializing reminder sheets:', error);
  }
}

// 启动服务器
async function startServer() {
  try {
    // 初始化工作表信息
    await initializeSheetInfo();

    // 初始化存档工作表
    await initializeArchiveSheet();

    // 初始化育儿提醒应用工作表
    await initializeReminderSheets();
    
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      console.log(`Visit http://localhost:${PORT} to use the application`);
      console.log(`Connected to Google Sheets: ${SPREADSHEET_ID}`);
      console.log(`Using worksheet: ${SHEET_NAME}`);
      console.log(`Archive sheet initialized: ${ARCHIVE_SHEET_NAME}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer(); 