/**
 * Google Sheets 数据结构初始化脚本
 * 用于创建育儿提醒应用所需的工作表
 */

const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
require('dotenv').config();

async function initializeSheets() {
    try {
        // 认证
        const auth = new GoogleAuth({
            keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });

        const sheets = google.sheets({ version: 'v4', auth });
        const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

        console.log('🚀 开始初始化 Google Sheets 数据结构...');

        // 1. 创建 Children 工作表（孩子信息）
        const childrenHeaders = [
            ['ID', '姓名', '年龄', '生日', '头像', '创建时间', '更新时间', '状态']
        ];

        // 2. 创建 Reminders 工作表（提醒任务）
        const remindersHeaders = [
            ['ID', '孩子ID', '标题', '描述', '分类', '提醒类型', '提醒时间', '重复规则', '提前提醒(分钟)', '启用状态', '创建时间', '更新时间']
        ];

        // 3. 创建 Records 工作表（完成记录）
        const recordsHeaders = [
            ['ID', '提醒ID', '孩子ID', '计划时间', '完成时间', '状态', '备注', '操作人', '创建时间']
        ];

        // 4. 创建 Categories 工作表（提醒分类）
        const categoriesHeaders = [
            ['ID', '分类名称', '图标', '颜色', '排序', '描述', '创建时间']
        ];

        // 预设分类数据
        const defaultCategories = [
            ['1', '喝水', '💧', '#4FC3F7', '1', '定时提醒喝水', new Date().toISOString()],
            ['2', '维他命', '💊', '#66BB6A', '2', '维他命和营养补充剂', new Date().toISOString()],
            ['3', '刷牙', '🦷', '#FF7043', '3', '口腔卫生护理', new Date().toISOString()],
            ['4', '午睡', '😴', '#9575CD', '4', '休息和睡眠', new Date().toISOString()],
            ['5', '运动', '🏃', '#FFB74D', '5', '体育锻炼活动', new Date().toISOString()],
            ['6', '补铁剂', '🩸', '#F06292', '6', '铁剂补充', new Date().toISOString()],
            ['7', '吃药', '💉', '#EF5350', '7', '药物服用提醒', new Date().toISOString()],
            ['8', '作业', '📚', '#5C6BC0', '8', '学习任务提醒', new Date().toISOString()],
            ['9', '其他', '📌', '#78909C', '9', '其他提醒事项', new Date().toISOString()]
        ];

        // 工作表配置
        const sheetsConfig = [
            { name: 'Children', headers: childrenHeaders, data: [] },
            { name: 'Reminders', headers: remindersHeaders, data: [] },
            { name: 'Records', headers: recordsHeaders, data: [] },
            { name: 'Categories', headers: categoriesHeaders, data: defaultCategories }
        ];

        // 获取现有工作表
        const spreadsheet = await sheets.spreadsheets.get({
            spreadsheetId: spreadsheetId
        });

        const existingSheets = spreadsheet.data.sheets.map(sheet => sheet.properties.title);
        console.log('📋 现有工作表:', existingSheets);

        // 批量请求
        const requests = [];

        // 为每个工作表创建请求
        for (const config of sheetsConfig) {
            if (!existingSheets.includes(config.name)) {
                // 添加新工作表
                requests.push({
                    addSheet: {
                        properties: {
                            title: config.name,
                            gridProperties: {
                                rowCount: 1000,
                                columnCount: 20
                            }
                        }
                    }
                });
                console.log(`✨ 将创建工作表: ${config.name}`);
            } else {
                console.log(`✓ 工作表已存在: ${config.name}`);
            }
        }

        // 执行批量更新
        if (requests.length > 0) {
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId: spreadsheetId,
                requestBody: {
                    requests: requests
                }
            });
            console.log('✅ 工作表创建完成');
        }

        // 写入表头和初始数据
        for (const config of sheetsConfig) {
            const range = `${config.name}!A1`;
            const values = [...config.headers, ...config.data];

            if (values.length > 0) {
                await sheets.spreadsheets.values.update({
                    spreadsheetId: spreadsheetId,
                    range: range,
                    valueInputOption: 'RAW',
                    requestBody: {
                        values: values
                    }
                });
                console.log(`📝 ${config.name} 表头和数据已写入`);
            }
        }

        // 设置表头格式
        const formatRequests = [];
        const sheetsList = await sheets.spreadsheets.get({
            spreadsheetId: spreadsheetId
        });

        for (const config of sheetsConfig) {
            const sheet = sheetsList.data.sheets.find(s => s.properties.title === config.name);
            if (sheet) {
                formatRequests.push({
                    repeatCell: {
                        range: {
                            sheetId: sheet.properties.sheetId,
                            startRowIndex: 0,
                            endRowIndex: 1
                        },
                        cell: {
                            userEnteredFormat: {
                                backgroundColor: { red: 0.2, green: 0.6, blue: 0.86 },
                                textFormat: {
                                    foregroundColor: { red: 1, green: 1, blue: 1 },
                                    bold: true
                                }
                            }
                        },
                        fields: 'userEnteredFormat(backgroundColor,textFormat)'
                    }
                });
            }
        }

        if (formatRequests.length > 0) {
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId: spreadsheetId,
                requestBody: {
                    requests: formatRequests
                }
            });
            console.log('🎨 表头格式设置完成');
        }

        console.log('\n✅ Google Sheets 数据结构初始化完成！');
        console.log('📊 已创建以下工作表:');
        console.log('   - Children: 孩子信息管理');
        console.log('   - Reminders: 提醒任务配置');
        console.log('   - Records: 完成记录追踪');
        console.log('   - Categories: 提醒分类管理');
        console.log('\n🎉 您可以开始使用育儿提醒应用了！');

    } catch (error) {
        console.error('❌ 初始化失败:', error.message);
        if (error.response) {
            console.error('错误详情:', error.response.data);
        }
        process.exit(1);
    }
}

// 运行初始化
initializeSheets();