/**
 * WidgetData / LatestArticle — port of Shared/Widget/WidgetData.swift
 *
 * The snapshot the app writes to the shared container for the home-screen widget.
 */

export interface LatestArticle {
  id: string;
  feedTitle: string;
  articleTitle?: string;
  articleSummary?: string;
  /** Path to image data in the shared container. */
  feedIconPath?: string;
  pubDate: string;
}

export interface WidgetData {
  totalUnreadCount: number;
  totalTodayCount: number;
  totalTodayUnreadCount: number;
  totalStarredCount: number;
  unreadArticles: LatestArticle[];
  starredArticles: LatestArticle[];
  todayArticles: LatestArticle[];
  lastUpdateTime: Date;
}
