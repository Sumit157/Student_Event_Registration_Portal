'use strict';

/**
 * routes/news.js
 * College news and announcements with paginated comments. (Assignment Task 5.)
 *
 * Comment content is sanitised on the way in (stored as plain text) AND the
 * client renders it with textContent, so stored XSS is blocked at both ends.
 */

const express = require('express');
const { body, param, query } = require('express-validator');

const { getPool } = require('../config/db');
const { ApiError } = require('../utils/errors');
const { asyncHandler } = require('../utils/asyncHandler');
const { validate } = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { stripTags } = require('../utils/sanitize');

const router = express.Router();

// ---------------------------------------------------------------------------
// News listing and detail (public)
// ---------------------------------------------------------------------------

router.get('/',
  validate([
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('pageSize').optional().isInt({ min: 1, max: 50 }).toInt(),
  ]),
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 10));
    const offset = (page - 1) * pageSize;

    const [countRows] = await getPool().execute(`SELECT COUNT(*) AS total FROM news WHERE is_active = 1`);
    const total = Number(countRows[0].total);

    const [rows] = await getPool().execute(
      `SELECT n.id, n.title, n.content, n.created_at, u.name AS author_name,
              (SELECT COUNT(*) FROM comments c WHERE c.news_id = n.id) AS comment_count
         FROM news n
         LEFT JOIN users u ON u.id = n.author_id
        WHERE n.is_active = 1
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT ${pageSize} OFFSET ${offset}`
    );

    res.json({
      success: true,
      data: {
        news: rows.map((row) => ({
          id: row.id,
          title: row.title,
          // A short preview for the card; the full body is on the detail page.
          excerpt: String(row.content || '').slice(0, 220),
          authorName: row.author_name || 'College Office',
          commentCount: Number(row.comment_count),
          createdAt: row.created_at,
        })),
        pagination: {
          page, pageSize, total,
          totalPages: Math.max(1, Math.ceil(total / pageSize)),
          hasNext: page * pageSize < total,
          hasPrev: page > 1,
        },
      },
    });
  })
);

router.get('/:id',
  validate([param('id').isInt({ min: 1 }).toInt()]),
  asyncHandler(async (req, res) => {
    const [rows] = await getPool().execute(
      `SELECT n.id, n.title, n.content, n.created_at, n.updated_at, u.name AS author_name,
              (SELECT COUNT(*) FROM comments c WHERE c.news_id = n.id) AS comment_count
         FROM news n LEFT JOIN users u ON u.id = n.author_id
        WHERE n.id = ? AND n.is_active = 1`,
      [req.params.id]
    );
    if (!rows[0]) throw ApiError.notFound('That announcement could not be found.', 'NEWS_NOT_FOUND');
    const row = rows[0];
    res.json({
      success: true,
      data: {
        news: {
          id: row.id,
          title: row.title,
          content: row.content,
          authorName: row.author_name || 'College Office',
          commentCount: Number(row.comment_count),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
      },
    });
  })
);

// ---------------------------------------------------------------------------
// Comments (paginated)
// ---------------------------------------------------------------------------

router.get('/:id/comments',
  validate([
    param('id').isInt({ min: 1 }).toInt(),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('pageSize').optional().isInt({ min: 1, max: 50 }).toInt(),
  ]),
  asyncHandler(async (req, res) => {
    const newsId = req.params.id;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 10));
    const offset = (page - 1) * pageSize;

    const [countRows] = await getPool().execute(`SELECT COUNT(*) AS total FROM comments WHERE news_id = ?`, [newsId]);
    const total = Number(countRows[0].total);

    const [rows] = await getPool().execute(
      `SELECT c.id, c.content, c.created_at, u.id AS user_id, u.name, a.profile_picture
         FROM comments c
         JOIN users u ON u.id = c.user_id
         LEFT JOIN alumni_profiles a ON a.user_id = u.id
        WHERE c.news_id = ?
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ${pageSize} OFFSET ${offset}`,
      [newsId]
    );

    res.json({
      success: true,
      data: {
        comments: rows.map((row) => ({
          id: row.id,
          content: row.content,
          createdAt: row.created_at,
          author: {
            userId: row.user_id,
            name: row.name,
            avatarUrl: row.profile_picture ? `/uploads/${row.profile_picture}` : null,
          },
        })),
        pagination: {
          page, pageSize, total,
          totalPages: Math.max(1, Math.ceil(total / pageSize)),
          hasNext: page * pageSize < total,
          hasPrev: page > 1,
        },
      },
    });
  })
);

router.post('/:id/comments',
  authenticate,
  validate([
    param('id').isInt({ min: 1 }).toInt(),
    body('content').trim().isLength({ min: 1, max: 1000 })
      .withMessage('Comment must be between 1 and 1000 characters.'),
  ]),
  asyncHandler(async (req, res) => {
    const newsId = req.params.id;

    const [newsRows] = await getPool().execute(`SELECT id FROM news WHERE id = ? AND is_active = 1`, [newsId]);
    if (!newsRows[0]) throw ApiError.notFound('That announcement could not be found.', 'NEWS_NOT_FOUND');

    // stripTags stores plain text; the client also renders via textContent.
    const content = stripTags(req.body.content, 1000);
    if (!content) throw ApiError.badRequest('Comment cannot be empty.', 'EMPTY_COMMENT');

    const [result] = await getPool().execute(
      `INSERT INTO comments (news_id, user_id, content) VALUES (?, ?, ?)`,
      [newsId, req.user.id, content]
    );

    res.status(201).json({
      success: true,
      message: 'Comment posted.',
      data: {
        comment: {
          id: result.insertId,
          content,
          createdAt: new Date().toISOString(),
          author: { userId: req.user.id, name: req.user.name, avatarUrl: null },
        },
      },
    });
  })
);

router.delete('/:id/comments/:commentId',
  authenticate,
  validate([param('id').isInt({ min: 1 }).toInt(), param('commentId').isInt({ min: 1 }).toInt()]),
  asyncHandler(async (req, res) => {
    const [rows] = await getPool().execute(`SELECT user_id FROM comments WHERE id = ?`, [req.params.commentId]);
    if (!rows[0]) throw ApiError.notFound('That comment could not be found.', 'COMMENT_NOT_FOUND');
    // Only the comment's author or an administrator may delete it.
    if (Number(rows[0].user_id) !== req.user.id && req.user.role !== 'admin') {
      throw ApiError.forbidden('You can only delete your own comments.', 'NOT_COMMENT_OWNER');
    }
    await getPool().execute(`DELETE FROM comments WHERE id = ?`, [req.params.commentId]);
    res.json({ success: true, message: 'Comment deleted.' });
  })
);

// ---------------------------------------------------------------------------
// Create / remove news (administrators only)
// ---------------------------------------------------------------------------

router.post('/',
  authenticate,
  authorize('admin'),
  validate([
    body('title').trim().isLength({ min: 3, max: 200 }).withMessage('Title must be 3-200 characters.').escape(),
    body('content').trim().isLength({ min: 10, max: 10000 }).withMessage('Content must be 10-10000 characters.'),
  ]),
  asyncHandler(async (req, res) => {
    const [result] = await getPool().execute(
      `INSERT INTO news (title, content, author_id) VALUES (?, ?, ?)`,
      [stripTags(req.body.title, 200), stripTags(req.body.content, 10000), req.user.id]
    );
    res.status(201).json({ success: true, message: 'Announcement published.', data: { id: result.insertId } });
  })
);

router.delete('/:id',
  authenticate,
  authorize('admin'),
  validate([param('id').isInt({ min: 1 }).toInt()]),
  asyncHandler(async (req, res) => {
    const [rows] = await getPool().execute(`SELECT id FROM news WHERE id = ?`, [req.params.id]);
    if (!rows[0]) throw ApiError.notFound('That announcement could not be found.', 'NEWS_NOT_FOUND');
    await getPool().execute(`UPDATE news SET is_active = 0 WHERE id = ?`, [req.params.id]);
    res.json({ success: true, message: 'Announcement removed.' });
  })
);

module.exports = router;
